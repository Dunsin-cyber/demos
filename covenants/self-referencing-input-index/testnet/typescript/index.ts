import {
  arkade,
  buildOffchainTx,
  setArkPsbtField,
  getNetwork,
  PrevArkTxField,
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

const MIN_AMOUNT = 1_000n;
const DEPOSIT_AMOUNT = 1_000n;
const REQUIRED_COINS = 2;

/**
 * A covenant program, `selfReferencingInputIndex`, that only lets the operator move funds when the
 * coin it is currently guarding is worth at least MIN_AMOUNT. It reads its OWN input index with
 * PUSHCURRENTINPUTINDEX instead of a hardcoded number, so one rule correctly guards a coin at any
 * position in the input list.
 */
const program = {
  version: 0,
  params: ["operatorPubkey", "minAmount"],
  functions: {
    selfReferencingInputIndex: {
      /** Tapscript-level signer requirement: only the operator key. */
      tapscript: { signers: ["$operatorPubkey"] },
      /** Covenant clause: my own input's value must be at least minAmount. */
      arkadeScript: {
        asm: ["PUSHCURRENTINPUTINDEX", "INSPECTINPUTVALUE", "$minAmount", "GREATERTHANOREQUAL"],
      },
    },
  },
} as const satisfies Program;

const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;
const FAUCET_URL = "https://faucet.mutinynet.arkade.sh/faucet" as const;

/** 1. Create script builder with support for cosigner, indexer and emulator. */
const operator = new RestArkProvider(OPERATOR_URL);
const indexer = new RestIndexerProvider(OPERATOR_URL);
const emulator = new RestEmulatorProvider(EMULATOR_URL);
const network = getNetwork("mutinynet");

const builder = await ContractBuilder.connect({
  arkade: operator,
  indexer,
  emulator,
  network,
});

/** 2. Instantiate the contract, binding the program's params to concrete values. */
const contract = builder.contract(program, {
  operatorPubkey: builder.serverKey,
  minAmount: MIN_AMOUNT,
});

/**
 * The whole point is that ONE covenant guards coins at different input positions, so we spend two
 * coins from the contract. Fund it twice so the demo runs end to end without a separate manual step.
 */
await fundViaFaucet(contract.address, Number(DEPOSIT_AMOUNT));
await fundViaFaucet(contract.address, Number(DEPOSIT_AMOUNT));

/** 3. Wait until both coins land, then spend them together. */
const contractInputs = await waitFor(async () => {
  const utxos = await contract.getUtxos();
  return utxos.length >= REQUIRED_COINS ? utxos : [];
}, `${REQUIRED_COINS} coins from the faucet`);

const contractBalance = contractInputs.reduce(
  (total, input) => total + BigInt(input.value),
  0n,
);

/** The compiled `selfReferencingInputIndex` spending path: its tapscript leaf and raw arkadeScript bytes. */
const selfReferencingInputIndex = contract.vtxoScript.functionByName("selfReferencingInputIndex")!;

/** Transform into PSBT inputs, all spent via the same leaf. Each will self-check its own value. */
const inputs = contractInputs.map(({ txid, vout, value }) => ({
  txid,
  vout,
  value,
  /** The tapscript leaf (+ control block) authorizing this spend. */
  tapLeafScript: selfReferencingInputIndex.tapLeafScript,
  /** The contract's encoded taproot script tree. */
  tapTree: contract.tapTree,
}));

/** This covenant constrains inputs, not any output, so the whole balance goes back to the contract. */
const outputs = [{ script: contract.pkScript, amount: contractBalance }];

/**
 * Construct Arkade extension envelope.
 * The emulator runs the arkadeScript once per covenant input, and PUSHCURRENTINPUTINDEX makes each
 * run inspect the input it is attached to, so we need one packet entry per input index.
 */
outputs.push(
  Extension.create([
    EmulatorPacket.create(
      inputs.map((_, vin) => ({ vin, script: selfReferencingInputIndex.arkadeScript! })),
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

/** Attach each input's source transaction as its PrevArkTxField, which the emulator requires. */
for (let i = 0; i < inputs.length; i++) {
  const { txs } = await indexer.getVirtualTxs([inputs[i].txid]);
  if (!txs[0]) {
    throw new Error(`indexer returned no virtual tx for input txid ${inputs[i].txid}`);
  }
  const sourceTx = Transaction.fromPSBT(base64.decode(txs[0])).unsignedTx;
  setArkPsbtField(arkTx, i, PrevArkTxField, sourceTx);
}

/**
 * 5. Submit transaction.
 * `selfReferencingInputIndex` is signed only by the operator (`$operatorPubkey`)
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
  `Covenant satisfied: each input self-checked its own value >= ${MIN_AMOUNT} sats, spent ${inputs.length} input(s): ${EXPLORER_URL}/tx/${txid}`,
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask the Arkade faucet to fund an ark address directly (offchain). */
async function fundViaFaucet(address: string, amount: number): Promise<void> {
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, amount }),
  });
  if (!res.ok) throw new Error(`faucet failed: ${res.status} ${await res.text()}`);
}

/** Poll until a lookup returns at least one item, or time out. */
async function waitFor<T>(
  lookup: () => Promise<T[]>,
  label: string,
  timeoutMs = 60_000,
): Promise<T[]> {
  console.log(`Waiting for ${label}...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await lookup();
    if (items.length > 0) return items;
    await sleep(3_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}
