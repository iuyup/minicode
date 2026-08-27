import assert from "node:assert/strict";
import test from "node:test";

import {
  getModelProfile,
  getModelProfileReadiness,
  parseModelProfileId,
  resolveOpenAiCompatibleProfile,
} from "../src/models/model-profiles.ts";
import { activeModelName, modelLabel, parseArguments } from "../src/runtime.ts";

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
  assert.equal(resolved.allowInsecureHttp, false);
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

test("OpenAI-compatible Profile 拒绝不可安全请求的 baseUrl", () => {
  const environmentFor = (baseUrl: string, allowInsecureHttp?: string): NodeJS.ProcessEnv => ({
    MINICODE_OPENAI_BASE_URL: baseUrl,
    MINICODE_OPENAI_MODEL: "coder-model",
    MINICODE_OPENAI_API_KEY: "test-secret-key",
    ...(allowInsecureHttp === undefined ? {} : { MINICODE_ALLOW_INSECURE_HTTP: allowInsecureHttp }),
  });
  const readinessFor = (baseUrl: string, allowInsecureHttp?: string) => {
    const environment = environmentFor(baseUrl, allowInsecureHttp);
    return getModelProfileReadiness(getModelProfile("openai-compatible", environment), environment);
  };

  assert.match(readinessFor("not a url").reason ?? "", /有效 URL/);
  assert.match(readinessFor("ftp://gateway.example/v1").reason ?? "", /http 或 https/);
  assert.match(readinessFor("https://user:secret@gateway.example/v1").reason ?? "", /用户名或密码/);
  assert.match(readinessFor("https://gateway.example/v1#admin").reason ?? "", /URL 片段/);
  assert.match(readinessFor("https://gateway.example/v1#").reason ?? "", /URL 片段/);
  assert.match(readinessFor("https://gateway.example/v1?tenant=demo").reason ?? "", /查询参数/);
  assert.match(readinessFor("https://gateway.example/v1?").reason ?? "", /查询参数/);
  assert.deepEqual(readinessFor("http://localhost:8080/v1"), { ready: true });
  assert.deepEqual(readinessFor("http://127.0.0.1:8080/v1"), { ready: true });
  assert.deepEqual(readinessFor("http://[::1]:8080/v1"), { ready: true });
  assert.match(readinessFor("http://gateway.example/v1").reason ?? "", /非本机 HTTP/);
  assert.match(readinessFor("http://gateway.example/v1", "true").reason ?? "", /非本机 HTTP/);
  assert.deepEqual(readinessFor("http://gateway.example/v1", "1"), { ready: true });

  const insecureEnvironment = environmentFor("http://gateway.example/v1", "1");
  assert.equal(resolveOpenAiCompatibleProfile("openai-compatible", insecureEnvironment).allowInsecureHttp, true);
});

test("CLI 支持 Profile 选择，同时保留 DeepSeek 旧参数", () => {
  assert.equal(parseModelProfileId("openai"), "openai-compatible");
  assert.equal(parseArguments(["--profile", "openai", "检查项目"]).modelProfile, "openai-compatible");
  assert.equal(parseArguments(["--model", "deepseek", "检查项目"]).modelProfile, "deepseek");
});

test("紧凑模型名与完整 Profile 标签分开，避免底栏解析斜杠字符串", () => {
  const deepseek = parseArguments([
    "--model",
    "deepseek",
    "--deepseek-model",
    "deepseek-v4-flash",
  ]);
  assert.equal(modelLabel(deepseek), "DeepSeek / deepseek-v4-flash");
  assert.equal(activeModelName(deepseek), "deepseek-v4-flash");
  assert.equal(activeModelName(parseArguments([])), "FakeModel（离线）");
});
