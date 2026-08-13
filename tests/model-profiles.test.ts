import assert from "node:assert/strict";
import test from "node:test";

import {
  getModelProfile,
  getModelProfileReadiness,
  parseModelProfileId,
  resolveOpenAiCompatibleProfile,
} from "../src/models/model-profiles.ts";
import { parseArguments } from "../src/runtime.ts";

test("OpenAI-compatible Profile 从环境变量解析连接信息，而 Profile 本身不含 API Key", () => {
  const environment: NodeJS.ProcessEnv = {
    MINICODE_OPENAI_BASE_URL: "https://gateway.example/v1",
    MINICODE_OPENAI_MODEL: "coder-model",
    MINICODE_OPENAI_API_KEY: "test-secret-key",
  };
  const profile = getModelProfile("openai-compatible", environment);
  const resolved = resolveOpenAiCompatibleProfile("openai-compatible", environment);

  assert.equal(profile.kind, "openai-compatible");
  assert.equal(profile.baseUrl, "https://gateway.example/v1");
  assert.equal(profile.model, "coder-model");
  assert.equal(profile.apiKeyEnvironmentVariable, "MINICODE_OPENAI_API_KEY");
  assert.equal(JSON.stringify(profile).includes("test-secret-key"), false);
  assert.equal(resolved.apiKey, "test-secret-key");
  assert.deepEqual(getModelProfileReadiness(profile, environment), { ready: true });
});

test("Profile 配置不完整时只指出缺少的环境变量，不回显密钥", () => {
  const incompleteProfile = getModelProfile("openai-compatible", {});

  assert.deepEqual(getModelProfileReadiness(incompleteProfile, {}), {
    ready: false,
    reason: "缺少 baseUrl 环境变量",
  });
  assert.throws(
    () => resolveOpenAiCompatibleProfile("openai-compatible", {
      MINICODE_OPENAI_BASE_URL: "https://gateway.example/v1",
      MINICODE_OPENAI_MODEL: "coder-model",
    }),
    /缺少 MINICODE_OPENAI_API_KEY/,
  );
});

test("CLI 支持 Profile 选择，同时保留 DeepSeek 旧参数", () => {
  assert.equal(parseModelProfileId("openai"), "openai-compatible");
  assert.equal(parseArguments(["--profile", "openai", "检查项目"]).modelProfile, "openai-compatible");
  assert.equal(parseArguments(["--model", "deepseek", "检查项目"]).modelProfile, "deepseek");
});
