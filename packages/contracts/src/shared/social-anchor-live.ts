import { canonicalDigest } from "@clawz/protocol";
import {
  Field,
  Mina,
  Poseidon,
  PrivateKey,
  PublicKey,
  fetchAccount
} from "o1js";

import { SocialAnchorKernel } from "../social/SocialAnchorKernel.js";
import { normalizeGraphqlEndpoint } from "./network.js";

const ZERO_FIELD = Field.fromJSON("0");
let socialAnchorKernelCompiled = false;

export interface SocialAnchorBatchCommitmentInput {
  batchId: string;
  sessionId: string;
  rootDigestSha256: string;
}

export interface SubmitSocialAnchorBatchOnZekoInput extends SocialAnchorBatchCommitmentInput {
  submitterPrivateKey: string;
  socialAnchorPrivateKey: string;
  socialAnchorPublicKey?: string;
  networkId?: string;
  mina?: string;
  archive?: string;
  fee?: string;
}

export interface SubmitSocialAnchorBatchOnZekoResult {
  networkId: string;
  contractAddress: string;
  anchorField: string;
  digestField: string;
  txHash?: string;
}

function digestToField(value: unknown): Field {
  const digest = canonicalDigest(value);
  const chunks = digest.fieldChunks.map((chunk) => Field.fromJSON(chunk));
  return Poseidon.hash(chunks.length > 0 ? chunks : [ZERO_FIELD]);
}

export function buildSocialAnchorBatchDigestField(rootDigestSha256: string): Field {
  return digestToField({
    type: "clawz-social-anchor-digest-v1",
    rootDigestSha256
  });
}

export function buildSocialAnchorBatchRootField(input: SocialAnchorBatchCommitmentInput): Field {
  return digestToField({
    type: "clawz-social-anchor-batch-v1",
    batchId: input.batchId,
    sessionId: input.sessionId,
    rootDigestSha256: input.rootDigestSha256
  });
}

export async function submitSocialAnchorBatchOnZeko(
  input: SubmitSocialAnchorBatchOnZekoInput
): Promise<SubmitSocialAnchorBatchOnZekoResult> {
  const networkId = input.networkId ?? "testnet";
  const mina = normalizeGraphqlEndpoint(input.mina ?? "https://testnet.zeko.io/graphql");
  const archive = normalizeGraphqlEndpoint(input.archive ?? mina);
  const network = Mina.Network({
    networkId: networkId as never,
    mina,
    archive
  });
  Mina.setActiveInstance(network);

  if (!socialAnchorKernelCompiled) {
    await SocialAnchorKernel.compile();
    socialAnchorKernelCompiled = true;
  }

  const submitter = PrivateKey.fromBase58(input.submitterPrivateKey);
  const socialAnchorKey = PrivateKey.fromBase58(input.socialAnchorPrivateKey);
  const contractAddress = input.socialAnchorPublicKey
    ? PublicKey.fromBase58(input.socialAnchorPublicKey)
    : socialAnchorKey.toPublicKey();
  const contractAddressBase58 = contractAddress.toBase58();
  const contractAccount = await fetchAccount({ publicKey: contractAddress });
  if (contractAccount.error) {
    throw new Error(
      `SocialAnchorKernel account not found on ${networkId}: ${contractAddressBase58}. Deploy the contract before anchoring batches.`
    );
  }

  const batchRootField = buildSocialAnchorBatchRootField(input);
  const batchDigestField = buildSocialAnchorBatchDigestField(input.rootDigestSha256);
  const kernel = new SocialAnchorKernel(contractAddress);

  const tx = await Mina.transaction({ sender: submitter.toPublicKey(), fee: input.fee ?? "100000000" }, async () => {
    await kernel.anchorBatch(batchRootField, batchDigestField);
  });
  const pending = await tx.sign([submitter, socialAnchorKey]).send();
  const txHash =
    typeof pending === "object" &&
    pending !== null &&
    "hash" in pending &&
    typeof (pending as { hash?: unknown }).hash === "string"
      ? ((pending as { hash: string }).hash)
      : undefined;

  return {
    networkId,
    contractAddress: contractAddressBase58,
    anchorField: batchRootField.toString(),
    digestField: batchDigestField.toString(),
    ...(txHash ? { txHash } : {})
  };
}
