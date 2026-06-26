// Pushes a Microsoft Entra bearer (from the main-process MSAL flow) into goosed
// config so the `caros` provider can call the gateway. We push only the access
// token + its expiry — never a refresh token — because the desktop owns renewal
// (MSAL), which keeps the provider's own CLI refresh path dormant.

type UpsertFn = (key: string, value: unknown, isSecret: boolean) => Promise<void>;

interface CarosTokenLike {
  accessToken: string;
  expiresAt: number;
}

export async function pushCarosToken(upsert: UpsertFn, token: CarosTokenLike): Promise<void> {
  await upsert('CAROS_TOKEN', token.accessToken, true);
  await upsert('CAROS_TOKEN_EXPIRY', token.expiresAt, false);
}
