import {
  arkade,
  buildOffchainTx,
  EmulatorPacket,
  Extension,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  Transaction,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

const { Arkade: ContractBuilder } = arkade;
type Program = typeof arkade.Program;

const INSPECTED_INPUT_INDEX = 0;
const MIN_AMOUNT = 1_000n;

/**
 * A basic covenant contract program, `requireMinInputValue`, that only lets the operator move funds
 * when input[INSPECTED_INPUT_INDEX] is worth at least MIN_AMOUNT.
 */
const program = {
  version: 0,
  params: ["operatorPubkey", "minAmount"],
  functions: {
    requireMinInputValue: {
      /** Tapscript-level signer requirement: only the operator key. */
      tapscript: { signers: ["$operatorPubkey"] },
      /** Covenant clause executed by the emulator on every spend. */
      arkadeScript: {
        asm: [INSPECTED_INPUT_INDEX, "INSPECTINPUTVALUE", "$minAmount", "GREATERTHANOREQUAL"],
      },
    },
  },
} as const satisfies Program;

const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

/** 1. Create script builder with support for cosigner, indexer and emulator. */
const builder = await ContractBuilder.connect({
  arkade: new RestArkProvider(OPERATOR_URL),
  indexer: new RestIndexerProvider(OPERATOR_URL),
  emulator: new RestEmulatorProvider(EMULATOR_URL),
});

/** 2. Instantiate the contract, binding the program's params to concrete values. */
const contract = builder.contract(program, {
  operatorPubkey: builder.serverKey,
  minAmount: MIN_AMOUNT,
});

/** 3. Fetch contract inputs and determine whether the contract can be executed. */
const contractInputs = await contract.getUtxos();

if (contractInputs.length === 0) {
  throw new Error("Contract address not funded", {
    cause: { address: contract.address, min: MIN_AMOUNT },
  });
}

const contractBalance = contractInputs.reduce(
  (total, input) => total + BigInt(input.value),
  0n,
);

/** The covenant inspects input 0, so that coin must clear the minimum. */
const firstInputValue = BigInt(contractInputs[0].value);
if (firstInputValue < MIN_AMOUNT) {
  throw new Error("Coin at input 0 is below the required minimum", {
    cause: { 
      address: contract.address, 
      min: MIN_AMOUNT, 
      got: firstInputValue,
     },
  });
}

/** The compiled `requireMinInputValue` spending path: its tapscript leaf and raw arkadeScript bytes. */
const requireMinInputValue = contract.vtxoScript.functionByName("requireMinInputValue")!;

/** Transform into PSBT inputs, all spent via the same `requireMinInputValue` leaf. */
const inputs = contractInputs.map(({ txid, vout, value }) => ({
  txid,
  vout,
  value,
  /** The tapscript leaf (+ control block) authorizing this spend. */
  tapLeafScript: requireMinInputValue.tapLeafScript,
  /** The contract's encoded taproot script tree. */
  tapTree: contract.tapTree,
}));

/**
 * This covenant constrains an input's value, not any output, so there is no
 * exact-amount output to build: the whole balance goes back to the contract.
 */
const outputs = [{ script: contract.pkScript, amount: contractBalance }];

/**
 * Construct Arkade extension envelope.
 * The emulator executes `requireMinInputValue`'s arkadeScript once per covenant input,
 * so we need one packet entry per input index, all pointing at the same script.
 */
outputs.push(
  Extension.create([
    EmulatorPacket.create(
      inputs.map((_, vin) => ({ vin, script: requireMinInputValue.arkadeScript! })),
    ),
  ]).txOut(),
);

/** 4. Build the unsigned virtual transaction */
const { arkTx, checkpoints } = buildOffchainTx(
  inputs,
  outputs,
  /** The operator's checkpoint unroll tapscript. */
  builder.checkpoint,
);

/**
 * 5. Submit transaction.
 * `requireMinInputValue` is signed only by the operator (`$operatorPubkey`)
 * No client identity is involved, so the unsigned transaction goes straight to the emulator
 */
const submitted = await builder.emulator!.submitTx(
  base64.encode(arkTx.toPSBT()),
  checkpoints.map((c) => base64.encode(c.toPSBT())),
);

/**
 * 6. Extract the finalized transaction's ID
 */
const txid = Transaction.fromPSBT(base64.decode(submitted.signedArkTx)).id;
console.log(
  `Spent ${inputs.length} contract input(s): ${EXPLORER_URL}/tx/${txid}`,
);
