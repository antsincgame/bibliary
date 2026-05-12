import { ID, Permission, Query, Role } from "node-appwrite";

import { COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";

type RawPrefsDoc = RawDoc & {
  userId: string;
  data: string;
  updatedAt: string;
};

export type Preferences = Record<string, unknown>;

const DEFAULT_PREFERENCES: Preferences = {
  /* LLM provider assignments — populated when user configures models. */
  providerAssignments: {},
  providerSecretsEncrypted: {},
  /* Per-role model fallbacks (legacy keys preserved for Electron compat). */
  readerModel: null,
  extractorModel: null,
  visionOcrModel: null,
  /* UI prefs. */
  uiTheme: "neon",
  uiLocale: "ru",
};

export async function getPreferences(userId: string): Promise<Preferences> {
  const doc = await findPrefsDoc(userId);
  if (!doc) return { ...DEFAULT_PREFERENCES };
  return parseData(doc.data);
}

export async function setPreferences(
  userId: string,
  partial: Preferences,
): Promise<Preferences> {
  const existing = await getPreferences(userId);
  const merged = { ...existing, ...partial };
  await writePrefsDoc(userId, merged);
  return merged;
}

export async function resetPreferences(userId: string): Promise<Preferences> {
  const defaults = { ...DEFAULT_PREFERENCES };
  await writePrefsDoc(userId, defaults);
  return defaults;
}

export function getPreferenceDefaults(): Preferences {
  return { ...DEFAULT_PREFERENCES };
}

async function findPrefsDoc(userId: string): Promise<RawPrefsDoc | null> {
  const { databases, databaseId } = getAppwrite();
  const list = await databases.listDocuments<RawPrefsDoc>(
    databaseId,
    COLLECTIONS.userPreferences,
    [Query.equal("userId", userId), Query.limit(1)],
  );
  return list.documents[0] ?? null;
}

async function writePrefsDoc(userId: string, prefs: Preferences): Promise<void> {
  const { databases, databaseId } = getAppwrite();
  const data = JSON.stringify(prefs);
  const updatedAt = new Date().toISOString();

  const existing = await findPrefsDoc(userId);
  if (existing) {
    await databases.updateDocument(databaseId, COLLECTIONS.userPreferences, existing.$id, {
      data,
      updatedAt,
    });
    return;
  }

  try {
    await databases.createDocument(
      databaseId,
      COLLECTIONS.userPreferences,
      ID.unique(),
      { userId, data, updatedAt },
      [
        Permission.read(Role.user(userId)),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
      ],
    );
  } catch (err) {
    if (isAppwriteCode(err, 409)) {
      /* Race with concurrent create — retry once via update path. */
      const again = await findPrefsDoc(userId);
      if (again) {
        await databases.updateDocument(databaseId, COLLECTIONS.userPreferences, again.$id, {
          data,
          updatedAt,
        });
        return;
      }
    }
    throw err;
  }
}

function parseData(json: string): Preferences {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...DEFAULT_PREFERENCES, ...(parsed as Preferences) };
    }
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_PREFERENCES };
}
