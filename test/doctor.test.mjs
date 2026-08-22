import { test } from "node:test";
import assert from "node:assert/strict";
import { checkModels, fixModels } from "../src/doctor.mjs";

const EMPTY = { providers: {} };

test("provider 不存在時回報 provider-missing", () => {
  const { ok, problems } = checkModels(EMPTY);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.code === "provider-missing"));
});

test("模型未註冊時回報 model-missing", () => {
  const cfg = { providers: { omlx: { baseUrl: "http://127.0.0.1:8000/v1", models: [] } } };
  const { problems } = checkModels(cfg);
  assert.ok(problems.some((p) => p.code === "model-missing"));
});

test("模型缺 reasoning 與 compat 時各回報一筆", () => {
  const cfg = {
    providers: {
      omlx: {
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [{ id: "Qwen3.8-27B-oQ4e-mtp", name: "Qwen3.8", input: ["text"] }],
      },
    },
  };
  const { problems } = checkModels(cfg);
  assert.ok(problems.some((p) => p.code === "reasoning-missing"));
  assert.ok(problems.some((p) => p.code === "compat-missing"));
});

test("fixModels 補齊後 checkModels 全綠", () => {
  const fixed = fixModels(EMPTY);
  const { ok, problems } = checkModels(fixed);
  assert.equal(ok, true, JSON.stringify(problems));
});

test("fixModels 不改動傳入物件", () => {
  const input = { providers: {} };
  fixModels(input);
  assert.deepEqual(input, { providers: {} });
});

test("fixModels 補上的模型帶正確的 enable_thinking 綁定", () => {
  const fixed = fixModels(EMPTY);
  const m = fixed.providers.omlx.models.find((x) => x.id === "Qwen3.8-27B-oQ4e-mtp");
  assert.equal(m.reasoning, true);
  assert.deepEqual(m.compat.chatTemplateKwargs.enable_thinking, { $var: "thinking.enabled" });
});

test("drafter 模型被標記為不可派工", () => {
  const fixed = fixModels({
    providers: { omlx: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "Qwen3.6-27B-DFlash-draft" }] } },
  });
  const d = fixed.providers.omlx.models.find((x) => x.id === "Qwen3.6-27B-DFlash-draft");
  assert.equal(d["x-pi-delegate-forbidden"], true);
});

test("fixModels 保留既有的其他 provider", () => {
  const fixed = fixModels({ providers: { litellm: { baseUrl: "https://example/v1", models: [] } } });
  assert.ok(fixed.providers.litellm);
});
