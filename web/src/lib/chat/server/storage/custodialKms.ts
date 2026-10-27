// The two AWS KMS calls behind the custodial master, Encrypt and Decrypt.
// KMS encrypts the owner's age identity directly (it is far under Encrypt's 4 KB limit), so the KMS
// key never leaves AWS and every unwrap is a CloudTrail event. The owner is bound in as encryption
// context, so a key object copied onto another owner's path is refused by KMS itself.
//
// On Vercel, `CUSTODIAL_KMS_ROLE_ARN` names the role this deployment assumes with its own OIDC token,
// so no AWS secret sits in env (CUR-4269); the role's trust policy decides which environment may.
// Unset, credentials come from the SDK's default chain (local dev, a non-Vercel host). (CUR-4136)

import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { config } from "$lib/chat/server/config";

const clients = new Map<string, KMSClient>();

/** With the SDK's defaults a stalled STS or KMS call holds a person's first upload for as (CUR-4431)
 *  long as the socket stays open, retried three times. Each call here gets this long, twice. */
const KMS_CALL_LIMITS = {
	maxAttempts: 2,
	requestHandler: { connectionTimeout: 1_000, requestTimeout: 3_000 },
};

/** The region a key ARN lives in: `arn:aws:kms:<region>:<account>:key/<id>` or `…:alias/<name>`. */
export function kmsRegion(keyArn: string): string | null {
	const parts = keyArn.split(":");
	return parts.length >= 6 && parts[0] === "arn" && parts[2] === "kms" && parts[3] ? parts[3] : null;
}

function client(keyArn: string): KMSClient {
	const region = kmsRegion(keyArn);
	if (!region) throw new Error(`not a KMS key ARN: ${keyArn}`);
	const roleArn = config.CUSTODIAL_KMS_ROLE_ARN || undefined;
	const cacheKey = `${region} ${roleArn ?? ""}`;
	let c = clients.get(cacheKey);
	if (!c) {
		c = new KMSClient(
			roleArn
				? { region, ...KMS_CALL_LIMITS, credentials: awsCredentialsProvider({ roleArn, clientConfig: { region, ...KMS_CALL_LIMITS } }) }
				: { region, ...KMS_CALL_LIMITS }
		);
		clients.set(cacheKey, c);
	}
	return c;
}

export async function kmsEncrypt(keyArn: string, plaintext: Uint8Array, context: Record<string, string>): Promise<Uint8Array> {
	const out = await client(keyArn).send(new EncryptCommand({ KeyId: keyArn, Plaintext: plaintext, EncryptionContext: context }));
	if (!out.CiphertextBlob) throw new Error("KMS Encrypt returned no ciphertext");
	return out.CiphertextBlob;
}

/** Decrypt with this key only. KMS throws `InvalidCiphertextException` when the blob was made under
 *  another key or another owner's context, or was altered. */
export async function kmsDecrypt(keyArn: string, ciphertext: Uint8Array, context: Record<string, string>): Promise<Uint8Array> {
	const out = await client(keyArn).send(new DecryptCommand({ KeyId: keyArn, CiphertextBlob: ciphertext, EncryptionContext: context }));
	if (!out.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
	return out.Plaintext;
}
