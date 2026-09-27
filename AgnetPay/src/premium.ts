import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { cluster } from './api';

// Who signs the premium. The demo wallet is not here: the backend holds that key and pays for it.
export type Signer = { kind: 'phantom'; address: string } | { kind: 'local'; address: string; secret: Uint8Array };

type PhantomProvider = {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
};
export const phantom = (): PhantomProvider | null => {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : null;
};

const rpcUrl = cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : `https://api.${cluster}.solana.com`;
export const connection = () => new Connection(rpcUrl, 'confirmed');
export const balanceOf = async (address: string) => (await connection().getBalance(new PublicKey(address))) / LAMPORTS_PER_SOL;

export class PremiumError extends Error {}

const FEE_LAMPORTS = 5_000;

export async function payPremium(signer: Signer, insurer: string, amountSol: number, onStage: (s: string) => void): Promise<string> {
  const conn = connection();
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const from = new PublicKey(signer.address);
  const balance = await conn.getBalance(from);
  if (balance < lamports + FEE_LAMPORTS) {
    throw new PremiumError(`Your wallet has ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL, but the premium is ${amountSol.toFixed(4)} SOL plus a tiny network fee, so no policy was created. Get devnet SOL at faucet.solana.com or pick a smaller cover.`);
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: from, blockhash, lastValidBlockHeight })
    .add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(insurer), lamports }));
  let signed: Transaction;
  if (signer.kind === 'local') {
    tx.sign(Keypair.fromSecretKey(signer.secret));
    signed = tx;
  } else {
    const p = phantom();
    if (!p) throw new PremiumError('Phantom is not available any more. Reconnect your wallet in Step 1.');
    onStage('Approve the premium in Phantom');
    try { signed = await p.signTransaction(tx); }
    catch { throw new PremiumError('The premium was not approved in Phantom, so no policy was created.'); }
  }
  onStage('Paying the premium');
  let sig: string;
  try { sig = await conn.sendRawTransaction(signed.serialize()); }
  catch (e) { throw new PremiumError(`The premium could not be sent, so no policy was created. ${e instanceof Error ? e.message.split('\n')[0] : ''}`.trim()); }
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new PremiumError('The premium transaction failed on-chain, so no policy was created.');
  return sig;
}
