import {
  arkade,
  ArkAddress,
  buildOffchainTx,
  EmulatorPacket,
  Extension,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MnemonicIdentity,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  Transaction,
  Wallet,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { EventSource } from "eventsource";

const { Arkade: ContractBuilder } = arkade;
type Program = typeof arkade.Program;

/**
 * pin-input-to-an-outpoint covenant demo.
 *
 * The guard (the covenant coin) may only be spent if input 0 of the same
 * transaction spends one exact, pre-chosen coin (coin A), checked with
 * OP_INSPECTINPUTOUTPOINT. So spending the guard forces coin A to be co-spent.
 *
 * Flow: fund coin A first (we must own it to spend it), read its outpoint,
 * build the guard pinned to that outpoint, fund the guard, then spend both.
 */

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;

const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;
const FAUCET_URL = "https://faucet.mutinynet.arkade.sh/faucet" as const;

/** Sats the faucet drops into each coin (coin A and the guard). */
const DEPOSIT_AMOUNT = 1000;

/** The transaction input index the covenant inspects. Coin A must sit here. */
const PINNED_INPUT_INDEX = 0;

// The wallet uses server sent events; give Node a global EventSource.
(globalThis as any).EventSource = EventSource;

const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, { isMainnet: false });
const operator = new RestArkProvider(OPERATOR_URL);
const indexer = new RestIndexerProvider(OPERATOR_URL);
const emulator = new RestEmulatorProvider(EMULATOR_URL);

/** A wallet so we own, and can sign for, coin A. */
const wallet = await Wallet.create({
  identity,
  arkProvider: operator,
  indexerProvider: indexer,
  settlementConfig: false,
  storage: {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  },
});

/** 1. Fund coin A first, then read its outpoint. The guard needs it as a param. */
const walletAddress = await wallet.getAddress();
await fundViaFaucet(walletAddress, DEPOSIT_AMOUNT);

const [coinA] = await waitFor(() => wallet.getVtxos(), "coin A from the faucet");
console.log("Coin A outpoint:", { txid: coinA.txid, vout: coinA.vout });

const program = {
  version: 0,
  params: ["operatorPubkey", "pinnedTxid", "pinnedVout"],
  functions: {
    pinInput: {
      /** Only the operator signs on chain; the emulator key is added for us. */
      tapscript: { signers: ["$operatorPubkey"] },
      arkadeScript: {
        asm: [
          PINNED_INPUT_INDEX,
          "INSPECTINPUTOUTPOINT",
          "$pinnedVout",
          "EQUALVERIFY",
          "$pinnedTxid",
          "EQUAL",
        ],
      },
    },
  },
} as const satisfies Program;

const builder = await ContractBuilder.connect({ identity, arkade: operator, indexer, emulator });

const contract = builder.contract(program, {
  operatorPubkey: builder.serverKey,
  // The covenant reads the txid in internal (reversed) byte order, not display order.
  pinnedTxid: hex.decode(coinA.txid).reverse(),
  pinnedVout: coinA.vout,
});

/** 3. Fund the guard, then find its coin. */
await fundViaFaucet(contract.address, DEPOSIT_AMOUNT);
const [guardCoin] = await waitFor(() => contract.getUtxos(), "guard funding from the faucet");

/** 4. Build the spend that eats both coins. */
const pinInput = contract.vtxoScript.functionByName("pinInput")!;

const inputs = [
  // Input 0 MUST be coin A, because the covenant inspects index 0.
  // Coin A is a plain wallet coin, spent via its collaborative (forfeit) path.
  { ...coinA, tapLeafScript: coinA.forfeitTapLeafScript },
  // Input 1 is the guard itself, spent via the pinInput covenant path.
  {
    txid: guardCoin.txid,
    vout: guardCoin.vout,
    value: guardCoin.value,
    tapLeafScript: pinInput.tapLeafScript,
    tapTree: contract.tapTree,
  },
];

// No fixed-amount rule here, so send the whole value back to our wallet.
const totalValue = BigInt(coinA.value) + BigInt(guardCoin.value);
const walletPkScript = ArkAddress.decode(walletAddress).pkScript;
const outputs: any[] = [{ script: walletPkScript, amount: totalValue }];

// The emulator packet carries the covenant only for the guard input (index 1).
// Coin A is a plain coin with no covenant, so it gets no packet entry.
outputs.push(
  Extension.create([
    EmulatorPacket.create([{ vin: 1, script: pinInput.arkadeScript! }]),
  ]).txOut(),
);

/** 5. Sign coin A, then submit so the emulator co-signs the guard and checks the rule. */
const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, builder.checkpoint);

const signedArkTx = await identity.sign(arkTx, [PINNED_INPUT_INDEX]);

const submitted = await emulator.submitTx(
  base64.encode(signedArkTx.toPSBT()),
  checkpoints.map((c) => base64.encode(c.toPSBT())),
);

const txid = Transaction.fromPSBT(base64.decode(submitted.signedArkTx)).id;
console.log(`Pinned spend: ${EXPLORER_URL}/tx/${txid}`);

await wallet.dispose();




const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await lookup();
    if (items.length > 0) return items;
    await sleep(3_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}
