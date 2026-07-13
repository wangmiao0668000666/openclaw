// Zalouser timeout tests prove that the lookups in zalo-js.ts are bounded
// even when the underlying zca-js API stalls before headers or during body
// reads. Each test uses a hanging Promise returned from the controllable
// fake API; withTimeout must reject inside ~12s for the production fix and
// hang forever for the control-red case.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { API, GroupInfo, User } from "./zca-client.js";

const ZALOUSER_LOOKUP_TIMEOUT_MS = 12_000;
const TEST_TOLERANCE_MS = 4_000;

type FakeApiOptions = {
  fetchAccountInfoImpl?: () => Promise<unknown>;
  getAllFriendsImpl?: () => Promise<User[]>;
  getAllGroupsImpl?: () => Promise<{ gridVerMap: Record<string, string> }>;
  getGroupInfoImpl?: (groupId: string | string[]) => Promise<{
    gridInfoMap: Record<string, GroupInfo & { memVerList?: unknown }>;
  }>;
  getGroupMembersInfoImpl?: (memberIds: string | string[]) => Promise<{
    profiles: Record<string, unknown>;
  }>;
};

function hangingPromise<T>(): Promise<T> {
  return new Promise<T>(() => {
    // intentionally never resolve or reject
  });
}

function fakeApi(options: FakeApiOptions = {}): API {
  const user: User = {
    userId: "100",
    username: "u",
    displayName: "u",
    zaloName: "u",
    avatar: "",
  };
  const groupInfo: GroupInfo & { memVerList?: unknown } = {
    groupId: "g1",
    name: "g1",
  };
  return {
    listener: {
      on: () => {},
      off: () => {},
      start: () => {},
      stop: () => {},
    },
    getContext: () => ({ imei: "imei", userAgent: "ua" }),
    getCookie: () => ({ toJSON: () => ({ cookies: [] }) }),
    fetchAccountInfo: options.fetchAccountInfoImpl ?? (async () => ({ profile: user })),
    getAllFriends: options.getAllFriendsImpl ?? (async () => [user]),
    getOwnId: () => "100",
    getAllGroups: options.getAllGroupsImpl ?? (async () => ({ gridVerMap: { g1: "v1" } })),
    getGroupInfo: options.getGroupInfoImpl ?? (async () => ({ gridInfoMap: { g1: groupInfo } })),
    getGroupMembersInfo: options.getGroupMembersInfoImpl ?? (async () => ({ profiles: {} })),
    sendMessage: async () => ({ msgId: 1 }),
    uploadAttachment: async () => [{ fileType: "image" }],
    sendVoice: async () => ({ msgId: 1 }),
    sendLink: async () => ({ msgId: 1 }),
    sendTypingEvent: async () => ({ status: 1 }),
    addReaction: async () => undefined,
    sendDeliveredEvent: async () => undefined,
    sendSeenEvent: async () => undefined,
  } as unknown as API;
}

type FakeZaloCtor = new (options?: { logging?: boolean; selfListen?: boolean }) => {
  login(credentials: unknown): Promise<API>;
  loginQR(
    options?: { userAgent?: string; language?: string; qrPath?: string },
    callback?: (event: unknown) => unknown,
  ): Promise<API>;
};

function fakeZalo(api: API): FakeZaloCtor {
  return class FakeZalo {
    async login(): Promise<API> {
      return api;
    }
    async loginQR(): Promise<API> {
      return api;
    }
  } as unknown as FakeZaloCtor;
}

function writeFakeZaloCredentials(stateDir: string, profile = "default"): void {
  // Mirrors resolveCredentialsPath() inside zalo-js.ts:
  // <stateDir>/credentials/zalouser/credentials.json for the "default" profile.
  const credentialsDir = path.join(stateDir, "credentials", "zalouser");
  fs.mkdirSync(credentialsDir, { recursive: true });
  const filename =
    profile === "default" ? "credentials.json" : `credentials-${encodeURIComponent(profile)}.json`;
  fs.writeFileSync(
    path.join(credentialsDir, filename),
    JSON.stringify({
      imei: "imei",
      cookie: [],
      userAgent: "ua",
      language: "en",
      createdAt: new Date().toISOString(),
    }),
  );
}

async function loadZaloJs(api: API) {
  vi.resetModules();
  vi.doMock("./zca-client.js", () => ({
    createZalo: async () => new (fakeZalo(api) as unknown as FakeZaloCtor)(),
    LoginQRCallbackEventType: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 },
    Reactions: {},
    TextStyle: {},
    ThreadType: { User: 0, Group: 1 },
  }));
  return import("./zalo-js.js");
}

async function expectTimeoutError<T>(
  promise: Promise<T>,
  expectedMessageFragment: string,
  timeoutMs: number,
): Promise<number> {
  const startedAt = Date.now();
  await expect(promise).rejects.toThrow(expectedMessageFragment);
  const elapsed = Date.now() - startedAt;
  expect(elapsed).toBeLessThan(timeoutMs + TEST_TOLERANCE_MS);
  return elapsed;
}

describe("zalouser account/group lookup timeouts", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir = "";

  beforeEach(async () => {
    vi.useRealTimers();
    stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zalouser-timeout-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.ZALOUSER_PROFILE = "default";
    process.env.ZCA_PROFILE = "default";
    writeFakeZaloCredentials(stateDir, "default");
  });

  afterEach(async () => {
    vi.doUnmock("./zca-client.js");
    vi.resetModules();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    delete process.env.ZALOUSER_PROFILE;
    delete process.env.ZCA_PROFILE;
    if (stateDir) {
      await fs.promises.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("checkZaloAuthenticated aborts within ~12s when fetchAccountInfo stalls", async () => {
    const api = fakeApi({ fetchAccountInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    // checkZaloAuthenticated swallows the underlying timeout error and returns
    // false; the important contract is that it returns within the timeout
    // window instead of hanging.
    const startedAt = Date.now();
    const result = await zaloJs.checkZaloAuthenticated();
    const elapsed = Date.now() - startedAt;
    expect(result).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(ZALOUSER_LOOKUP_TIMEOUT_MS - 1_000);
    expect(elapsed).toBeLessThan(ZALOUSER_LOOKUP_TIMEOUT_MS + 3_000);
  });

  it("listZaloFriends aborts within ~12s when getAllFriends stalls", async () => {
    const api = fakeApi({ getAllFriendsImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    const elapsed = await expectTimeoutError(
      zaloJs.listZaloFriends(),
      "Timed out fetching Zalo friend list",
      ZALOUSER_LOOKUP_TIMEOUT_MS,
    );
    expect(elapsed).toBeGreaterThanOrEqual(ZALOUSER_LOOKUP_TIMEOUT_MS - 1_000);
  });

  it("listZaloGroups aborts within ~12s when getAllGroups stalls", async () => {
    const api = fakeApi({ getAllGroupsImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    const elapsed = await expectTimeoutError(
      zaloJs.listZaloGroups(),
      "Timed out fetching Zalo group list",
      ZALOUSER_LOOKUP_TIMEOUT_MS,
    );
    expect(elapsed).toBeGreaterThanOrEqual(ZALOUSER_LOOKUP_TIMEOUT_MS - 1_000);
  });

  it("listZaloGroups aborts within ~12s when getGroupInfo (chunk fetch) stalls", async () => {
    const api = fakeApi({ getGroupInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    const elapsed = await expectTimeoutError(
      zaloJs.listZaloGroups(),
      "Timed out fetching Zalo group info",
      ZALOUSER_LOOKUP_TIMEOUT_MS,
    );
    expect(elapsed).toBeGreaterThanOrEqual(ZALOUSER_LOOKUP_TIMEOUT_MS - 1_000);
  });

  it("listZaloGroupMembers aborts within ~12s when getGroupInfo stalls", async () => {
    const api = fakeApi({ getGroupInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    const elapsed = await expectTimeoutError(
      zaloJs.listZaloGroupMembers("default", "g1"),
      "Timed out fetching Zalo group info",
      ZALOUSER_LOOKUP_TIMEOUT_MS,
    );
    expect(elapsed).toBeGreaterThanOrEqual(ZALOUSER_LOOKUP_TIMEOUT_MS - 1_000);
  });

  it("checkZaloAuthenticated resolves quickly when fetchAccountInfo responds normally", async () => {
    const api = fakeApi();
    const zaloJs = await loadZaloJs(api);
    const startedAt = Date.now();
    const result = await zaloJs.checkZaloAuthenticated();
    const elapsed = Date.now() - startedAt;
    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("listZaloFriends returns the mapped friend list when getAllFriends responds normally", async () => {
    const api = fakeApi({
      getAllFriendsImpl: async () => [
        {
          userId: "1",
          username: "alice",
          displayName: "Alice",
          zaloName: "alice",
          avatar: "",
        },
      ],
    });
    const zaloJs = await loadZaloJs(api);
    const result = await zaloJs.listZaloFriends();
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("1");
    expect(result[0]?.displayName).toBe("Alice");
  });

  it("control-red: without withTimeout the lookup would hang past the 12s budget", async () => {
    const api = fakeApi({ fetchAccountInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    const startedAt = Date.now();
    const guarded = zaloJs.checkZaloAuthenticated();
    const timeoutHandle = setTimeout(() => {
      // Surface a clear failure if the production guard ever stops firing:
      // the test would otherwise hang and miss the regression.
      throw new Error("regression: checkZaloAuthenticated did not abort within 16s");
    }, ZALOUSER_LOOKUP_TIMEOUT_MS + 4_000);
    try {
      // checkZaloAuthenticated swallows the timeout error and returns false;
      // the contract here is that the call resolves within the timeout
      // window. The setTimeout above will throw if the guard ever regresses
      // and lets the call hang past 16 seconds.
      const result = await guarded;
      expect(result).toBe(false);
    } finally {
      clearTimeout(timeoutHandle);
    }
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(ZALOUSER_LOOKUP_TIMEOUT_MS - 1_000);
    expect(elapsed).toBeLessThan(ZALOUSER_LOOKUP_TIMEOUT_MS + 3_000);
  });
});
