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

const DEPOSIT_AMOUNT = 1_000n;
const REQUIRED_COINS = 2;

/**
 * A recursive covenant, `pinInputArkadeScript`, that only lets the operator move funds when
 * input 0 and input 1 are guarded by the SAME arkade script (their script hashes match).
 * Because both coins carry this very covenant, it enforces that its coins only ever move
 * alongside other coins under the identical covenant.
 */
const program = {
  version: 0,
  params: ["operatorPubkey"],
  functions: {
    pinInputArkadeScript: {
      /** Tapscript-level signer requirement: only the operator key. */
      tapscript: { signers: ["$operatorPubkey"] },
      /** Covenant clause executed by the emulator on every spend. */
      arkadeScript: {
        asm: [0, "INSPECTINPUTARKADESCRIPTHASH", 1, "INSPECTINPUTARKADESCRIPTHASH", "EQUAL"],
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

/** 2. Instantiate the contract. The covenant takes no params beyond the operator key. */
const contract = builder.contract(program, {
  operatorPubkey: builder.serverKey,
});

/**
 * The covenant compares input 0 and input 1, so it needs two coins under the same contract.
 * Fund the contract twice so the demo runs end to end without a separate manual step.
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

/** The compiled `pinInputArkadeScript` spending path: its tapscript leaf and raw arkadeScript bytes. */
const pinInputArkadeScript = contract.vtxoScript.functionByName("pinInputArkadeScript")!;

/** Transform into PSBT inputs, all spent via the same `pinInputArkadeScript` leaf. */
const inputs = contractInputs.map(({ txid, vout, value }) => ({
  txid,
  vout,
  value,
  /** The tapscript leaf (+ control block) authorizing this spend. */
  tapLeafScript: pinInputArkadeScript.tapLeafScript,
  /** The contract's encoded taproot script tree. */
  tapTree: contract.tapTree,
}));

/**
 * This covenant constrains inputs, not any output, so there is no exact-amount output
 * to build: the whole balance goes back to the contract.
 */
const outputs = [{ script: contract.pkScript, amount: contractBalance }];

/**
 * Construct Arkade extension envelope.
 * The emulator runs `pinInputArkadeScript` once per covenant input, and each entry's script is
 * exactly what INSPECTINPUTARKADESCRIPTHASH hashes, so every input carries the same script.
 */
outputs.push(
  Extension.create([
    EmulatorPacket.create(
      inputs.map((_, vin) => ({ vin, script: pinInputArkadeScript.arkadeScript! })),
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
 * `pinInputArkadeScript` is signed only by the operator (`$operatorPubkey`)
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
  `Covenant satisfied: inputs 0 and 1 share the same arkade script, spent ${inputs.length} input(s): ${EXPLORER_URL}/tx/${txid}`,
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
