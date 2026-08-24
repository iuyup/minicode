import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EVALUATION_ARMS,
  EVALUATION_BUDGET,
  EVALUATION_TRIALS,
  createEvaluationConfig,
  hashPublicEvaluationConfig,
  serializePublicEvaluationConfig,
  type EvaluationPricingSnapshot,
} from "../src/evals/eval-config.ts";

test("evaluation configuration freezes the suite, arms, and normalized budgets", () => {
  const config = createEvaluationConfig({ profileId: "fake", environment: {} });

  assert.equal(EVALUATION_TRIALS, 3);
  assert.deepEqual(EVALUATION_ARMS, [
    "baseline-3tool",
    "minicode-3tool",
    "minicode-product",
  ]);
  assert.deepEqual(EVALUATION_BUDGET, {
    baselineMaxModelRequests: 7,
    guidedBaseMaxModelRequests: 8,
    baseMaxAcceptedToolCalls: 6,
    failureRepairExtraToolCalls: 3,
    postRepairGitExtraToolCalls: 2,
    hardMaxModelRequests: 15,
    hardMaxAcceptedToolCalls: 11,
    maxToolCallsPerTurn: 1,
    maxOutputTokensPerRequest: 2_048,
    wallClockTimeoutMs: 180_000,
  });
  assert.equal(config.publicConfig.suite.trials, 3);
  assert.equal(config.publicConfig.model.model, "fake");
  assert.equal(config.publicConfig.cost.status, "unavailable");
  assert.equal(Object.isFrozen(config.publicConfig), true);
  assert.equal(Object.isFrozen(config.publicConfig.arms), true);
  assert.equal(Object.isFrozen(config.publicConfig.budget), true);
});

test("profile parsing records public connection metadata but never reads or stores an API key", () => {
  const secret = "must-not-enter-eval-config-91fc";
  const values: NodeJS.ProcessEnv = {
    MINICODE_OPENAI_BASE_URL: "https://models.example.test/v1",
    MINICODE_OPENAI_MODEL: "example-coder-1",
    MINICODE_OPENAI_API_KEY: secret,
  };
  const environment = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string" && property.includes("API_KEY")) {
        throw new Error("配置层不应读取 API key。");
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  const config = createEvaluationConfig({ profileId: "openai", environment });
  assert.deepEqual(config.publicConfig.model, {
    profileId: "openai-compatible",
    kind: "openai-compatible",
    model: "example-coder-1",
    endpointSha256: createHash("sha256")
      .update("https://models.example.test/v1", "utf8")
      .digest("hex"),
    disableThinking: false,
    allowInsecureHttp: false,
  });
  assert.equal(config.publicConfigJson.includes("models.example.test"), false);
  assert.equal(config.publicConfigJson.includes(secret), false);
  assert.equal(JSON.stringify(config).includes(secret), false);
  assert.equal(config.publicConfigJson.includes("API_KEY"), false);
});

test("missing pricing is explicit and a supplied snapshot is normalized and hash-bound", () => {
  const environment = { DEEPSEEK_MODEL: "deepseek-chat-eval" };
  const unavailable = createEvaluationConfig({ profileId: "deepseek", environment });
  assert.deepEqual(unavailable.publicConfig.cost, { status: "unavailable" });

  const pricing: EvaluationPricingSnapshot = {
    snapshotId: "deepseek-2026-08-24",
    profileId: "deepseek",
    model: "deepseek-chat-eval",
    effectiveAt: "2026-08-24T08:00:00+08:00",
    currency: "USD",
    inputUsdPerMillionTokens: 0.3,
    cachedInputUsdPerMillionTokens: 0.03,
    outputUsdPerMillionTokens: 1.2,
    source: "published-price-snapshot",
  };
  const configured = createEvaluationConfig({ profileId: "deepseek", environment, pricing });
  assert.equal(configured.publicConfig.cost.status, "configured");
  if (configured.publicConfig.cost.status !== "configured") throw new Error("缺少价格快照。");
  assert.equal(configured.publicConfig.cost.pricing.effectiveAt, "2026-08-24T00:00:00.000Z");
  assert.notEqual(configured.publicConfigSha256, unavailable.publicConfigSha256);

  assert.throws(
    () => createEvaluationConfig({
      profileId: "deepseek",
      environment,
      pricing: { ...pricing, model: "different-model" },
    }),
    /不匹配/u,
  );
  assert.throws(
    () => createEvaluationConfig({
      profileId: "deepseek",
      environment,
      pricing: { ...pricing, currency: "EUR" as "USD" },
    }),
    /currency.*USD/u,
  );
});

test("public configuration serialization and SHA-256 are stable", () => {
  const left = createEvaluationConfig({
    profileId: "openai-compatible",
    environment: {
      MINICODE_OPENAI_MODEL: "stable-coder",
      MINICODE_OPENAI_BASE_URL: "https://stable.example.test/v1",
    },
  });
  const right = createEvaluationConfig({
    profileId: "openai-compatible",
    environment: {
      MINICODE_OPENAI_BASE_URL: "https://stable.example.test/v1",
      MINICODE_OPENAI_MODEL: "stable-coder",
    },
  });

  assert.equal(left.publicConfigJson, right.publicConfigJson);
  assert.equal(left.publicConfigSha256, right.publicConfigSha256);
  assert.equal(left.publicConfigJson, serializePublicEvaluationConfig(left.publicConfig));
  assert.equal(left.publicConfigSha256, hashPublicEvaluationConfig(left.publicConfig));
  assert.equal(
    left.publicConfigSha256,
    createHash("sha256").update(left.publicConfigJson, "utf8").digest("hex"),
  );
  assert.match(left.publicConfigSha256, /^[a-f0-9]{64}$/u);
  assert.match(left.publicConfig.prompts["baseline-3tool"].systemSha256, /^[a-f0-9]{64}$/u);
  assert.equal(left.publicConfig.prompts["baseline-3tool"].planningSha256, null);

  const httpDenied = createEvaluationConfig({
    profileId: "openai-compatible",
    environment: {
      MINICODE_OPENAI_BASE_URL: "http://models.example.test/v1",
      MINICODE_OPENAI_MODEL: "stable-coder",
    },
  });
  const insecure = createEvaluationConfig({
    profileId: "openai-compatible",
    environment: {
      MINICODE_OPENAI_BASE_URL: "http://models.example.test/v1",
      MINICODE_OPENAI_MODEL: "stable-coder",
      MINICODE_ALLOW_INSECURE_HTTP: "1",
    },
  });
  assert.equal(insecure.publicConfig.model.kind, "openai-compatible");
  if (insecure.publicConfig.model.kind !== "openai-compatible") throw new Error("需要远程模型。 ");
  assert.equal(insecure.publicConfig.model.allowInsecureHttp, true);
  assert.equal(httpDenied.publicConfig.model.kind, "openai-compatible");
  if (httpDenied.publicConfig.model.kind !== "openai-compatible") throw new Error("需要远程模型。 ");
  assert.equal(httpDenied.publicConfig.model.allowInsecureHttp, false);
  assert.notEqual(insecure.publicConfigSha256, httpDenied.publicConfigSha256);
});

test("invalid profiles and incomplete public model metadata fail before a run starts", () => {
  assert.throws(
    () => createEvaluationConfig({ profileId: "unknown", environment: {} }),
    /未知评测 Profile/u,
  );
  assert.throws(
    () => createEvaluationConfig({ profileId: "openai-compatible", environment: {} }),
    /model.*不能为空/u,
  );
});
