import assert from "node:assert/strict";
import test from "node:test";

import healthHandler from "../api/health.js";
import mapFieldsHandler from "../api/map-fields.js";
import { HttpError, mapFieldsWithClaude } from "../server/index.js";

function responseRecorder() {
  const headers = new Map();
  return {
    body: "",
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name.toLocaleLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLocaleLowerCase());
    },
    end(value = "") {
      this.body = value;
    },
  };
}

test("Vercel health function reports configuration state as JSON", () => {
  const response = responseRecorder();
  healthHandler({ method: "GET" }, response);

  assert.equal(response.statusCode, 200);
  assert.match(response.getHeader("content-type"), /application\/json/);
  assert.equal(JSON.parse(response.body).ok, true);
});

test("Vercel map-fields function rejects unsupported methods as JSON", async () => {
  const response = responseRecorder();
  await mapFieldsHandler({ method: "GET" }, response);

  assert.equal(response.statusCode, 405);
  assert.equal(JSON.parse(response.body).error, "Method not allowed.");
});

test("Vercel map-fields function validates request bodies before Claude", async () => {
  const response = responseRecorder();
  await mapFieldsHandler({ method: "POST", body: {} }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "Clinical notes must be between 2 and 50,000 characters.");
});

test("Claude requests trim surrounding whitespace from the configured API key", async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "  sk-ant-test-key\n";
  global.fetch = async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(options.headers["x-api-key"], "sk-ant-test-key");
    const requestBody = JSON.parse(options.body);
    const confidenceSchema = requestBody.output_config.format.schema
      .properties.assignments.items.properties.confidence;
    assert.deepEqual(confidenceSchema, { type: "number" });
    const assignmentSchema = requestBody.output_config.format.schema
      .properties.assignments.items;
    assert.deepEqual(assignmentSchema.properties.matchType.enum, [
      "exact",
      "semantic",
      "unsupported",
    ]);
    assert.deepEqual(assignmentSchema.required, [
      "name",
      "value",
      "confidence",
      "matchType",
      "sourceText",
      "evidenceType",
    ]);
    return {
      ok: true,
      headers: { get: () => "request-test" },
      json: async () => ({
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{
          type: "text",
          text: JSON.stringify({
            assignments: [{
              name: "allergies",
              value: "None",
              confidence: 1,
              matchType: "exact",
              sourceText: "No allergies.",
              evidenceType: "record_documentation",
            }],
          }),
        }],
      }),
    };
  };

  try {
    const result = await mapFieldsWithClaude({
      fields: [{ name: "allergies", type: "TextField", options: [] }],
      freeText: "No allergies.",
      pdfBase64: "JVBERi0xLjQK",
    });
    assert.equal(result.assignments[0].value, "None");
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

test("Claude connection failures return a useful safe error", async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  global.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  try {
    await assert.rejects(
      () => mapFieldsWithClaude({
        fields: [{ name: "allergies", type: "TextField", options: [] }],
        freeText: "No allergies.",
        pdfBase64: "JVBERi0xLjQK",
      }),
      (error) => error instanceof HttpError
        && error.status === 502
        && /could not connect to Claude/.test(error.message),
    );
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

test("healthcare semantic matches include evidence and are forced into human review", async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  global.fetch = async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    const requestBody = JSON.parse(options.body);
    const prompt = requestBody.messages[0].content.find((block) => block.type === "text").text;
    assert.match(prompt, /"name":"tel".*"semanticHints":\["tel","telephone","phone","phone number","contact number"\]/);
    assert.match(requestBody.system, /HTN\/hypertension/);
    assert.match(requestBody.system, /T2DM\/type 2 diabetes/);
    assert.match(requestBody.system, /NKDA\/no known drug allergies/);
    assert.match(requestBody.system, /BID\/twice daily/);
    assert.match(requestBody.system, /denies tobacco use/);
    assert.match(requestBody.system, /Family history is not the patient's diagnosis/);
    assert.match(requestBody.system, /discontinued, historical, or held medication/);
    assert.match(requestBody.system, /adverse effect or intolerance is not an allergy/);
    assert.match(requestBody.system, /suspected, possible, rule-out, or differential diagnosis/);

    return {
      ok: true,
      headers: { get: () => "request-semantic-test" },
      json: async () => ({
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{
          type: "text",
          text: JSON.stringify({
            assignments: [
              {
                name: "diagnosis",
                value: "Hypertension",
                confidence: 0.98,
                matchType: "semantic",
                sourceText: "HTN",
                evidenceType: "record_documentation",
              },
              {
                name: "diabetes",
                value: "Type 2 diabetes",
                confidence: 0.97,
                matchType: "semantic",
                sourceText: "T2DM",
                evidenceType: "record_documentation",
              },
              {
                name: "allergies",
                value: "No known drug allergies",
                confidence: 0.99,
                matchType: "semantic",
                sourceText: "NKDA",
                evidenceType: "record_documentation",
              },
              {
                name: "frequency",
                value: "Twice daily",
                confidence: 0.96,
                matchType: "semantic",
                sourceText: "BID",
                evidenceType: "record_documentation",
              },
              {
                name: "whiteBloodCellCount",
                value: "7.2 x10^9/L",
                confidence: 0.95,
                matchType: "semantic",
                sourceText: "WBC 7.2 x10^9/L",
                evidenceType: "record_documentation",
              },
              {
                name: "smoking",
                value: "No",
                confidence: 0.94,
                matchType: "semantic",
                sourceText: "denies tobacco use",
                evidenceType: "patient_report",
              },
              {
                name: "race",
                value: "Caucasian",
                confidence: 0.98,
                matchType: "semantic",
                sourceText: "Race: White",
                evidenceType: "record_documentation",
              },
              {
                name: "tel",
                value: "905-555-0100",
                confidence: 0.96,
                matchType: "semantic",
                sourceText: "Phone number: 905-555-0100",
                evidenceType: "record_documentation",
              },
            ],
          }),
        }],
      }),
    };
  };

  try {
    const result = await mapFieldsWithClaude({
      fields: [
        { name: "diagnosis", type: "Dropdown", options: ["Hypertension", "Asthma"] },
        { name: "diabetes", type: "Dropdown", options: ["Type 1 diabetes", "Type 2 diabetes"] },
        { name: "allergies", type: "TextField", options: [] },
        { name: "frequency", type: "Dropdown", options: ["Once daily", "Twice daily"] },
        { name: "whiteBloodCellCount", type: "TextField", options: [] },
        { name: "smoking", type: "Dropdown", options: ["Yes", "No"] },
        { name: "race", type: "Dropdown", options: ["Caucasian", "Black", "Asian"] },
        { name: "tel", type: "TextField", options: [] },
      ],
      freeText: "HTN and T2DM. NKDA. Take BID. WBC 7.2 x10^9/L. Patient denies tobacco use. Race: White. Phone number: 905-555-0100.",
      pdfBase64: "JVBERi0xLjQK",
    });

    assert.equal(result.assignments.length, 8);
    for (const assignment of result.assignments) {
      assert.equal(assignment.semanticMatch, true);
      assert.equal(assignment.confidence, 0.69);
      assert.ok(assignment.sourceText);
      assert.ok(assignment.evidenceType);
    }
    assert.deepEqual(result.assignments.map(({ name, value }) => ({ name, value })), [
      { name: "diagnosis", value: "Hypertension" },
      { name: "diabetes", value: "Type 2 diabetes" },
      { name: "allergies", value: "No known drug allergies" },
      { name: "frequency", value: "Twice daily" },
      { name: "whiteBloodCellCount", value: "7.2 x10^9/L" },
      { name: "smoking", value: "No" },
      { name: "race", value: "Caucasian" },
      { name: "tel", value: "905-555-0100" },
    ]);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

test("medication semantics preserve identity and details while rejecting unsafe guesses", async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  global.fetch = async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    const requestBody = JSON.parse(options.body);
    assert.match(requestBody.system, /Synthroid\/levothyroxine/);
    assert.match(requestBody.system, /Tylenol\/acetaminophen/);
    assert.match(requestBody.system, /PO\/oral/);
    assert.match(requestBody.system, /PRN\/as needed/);
    assert.match(requestBody.system, /XR or ER\/extended-release/);
    assert.match(requestBody.system, /medication class is not a specific medication/);
    assert.match(requestBody.system, /Do not convert a generic ingredient to a brand/);
    assert.match(requestBody.system, /similar-looking, or sound-alike medication names/);
    assert.match(requestBody.system, /scheduled medication distinct from PRN use/);

    return {
      ok: true,
      headers: { get: () => "request-medication-test" },
      json: async () => ({
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{
          type: "text",
          text: JSON.stringify({
            assignments: [
              {
                name: "thyroidMedication",
                value: "Levothyroxine",
                confidence: 0.99,
                matchType: "semantic",
                sourceText: "Synthroid",
                evidenceType: "record_documentation",
              },
              {
                name: "thyroidStrength",
                value: "50 mcg",
                confidence: 0.99,
                matchType: "exact",
                sourceText: "50 mcg",
                evidenceType: "record_documentation",
              },
              {
                name: "thyroidRoute",
                value: "Oral",
                confidence: 0.98,
                matchType: "semantic",
                sourceText: "PO",
                evidenceType: "record_documentation",
              },
              {
                name: "thyroidFrequency",
                value: "Once daily",
                confidence: 0.98,
                matchType: "semantic",
                sourceText: "daily",
                evidenceType: "record_documentation",
              },
              {
                name: "analgesicMedication",
                value: "Acetaminophen",
                confidence: 0.99,
                matchType: "semantic",
                sourceText: "Tylenol",
                evidenceType: "record_documentation",
              },
              {
                name: "analgesicFrequency",
                value: "Every 6 hours as needed",
                confidence: 0.97,
                matchType: "semantic",
                sourceText: "q6h PRN",
                evidenceType: "record_documentation",
              },
              {
                name: "metforminFormulation",
                value: "Extended-release",
                confidence: 0.98,
                matchType: "semantic",
                sourceText: "Metformin XR",
                evidenceType: "record_documentation",
              },
              {
                name: "currentMetformin",
                value: true,
                confidence: 0,
                matchType: "unsupported",
                sourceText: null,
                evidenceType: "not_applicable",
              },
              {
                name: "codeineAllergy",
                value: true,
                confidence: 0,
                matchType: "unsupported",
                sourceText: null,
                evidenceType: "not_applicable",
              },
              {
                name: "specificGlp1Medication",
                value: "Ozempic",
                confidence: 0,
                matchType: "unsupported",
                sourceText: null,
                evidenceType: "not_applicable",
              },
            ],
          }),
        }],
      }),
    };
  };

  try {
    const result = await mapFieldsWithClaude({
      fields: [
        { name: "thyroidMedication", type: "Dropdown", options: ["Levothyroxine", "Liothyronine"] },
        { name: "thyroidStrength", type: "TextField", options: [] },
        { name: "thyroidRoute", type: "Dropdown", options: ["Oral", "Sublingual"] },
        { name: "thyroidFrequency", type: "Dropdown", options: ["Once daily", "Twice daily"] },
        { name: "analgesicMedication", type: "Dropdown", options: ["Acetaminophen", "Ibuprofen"] },
        { name: "analgesicFrequency", type: "Dropdown", options: ["Every 6 hours as needed", "Every 4 hours"] },
        { name: "metforminFormulation", type: "Dropdown", options: ["Immediate-release", "Extended-release"] },
        { name: "currentMetformin", type: "CheckBox", options: [] },
        { name: "codeineAllergy", type: "CheckBox", options: [] },
        { name: "specificGlp1Medication", type: "Dropdown", options: ["Ozempic", "Wegovy", "Mounjaro"] },
      ],
      freeText: "Current medications: Synthroid 50 mcg PO daily. Tylenol 500 mg PO q6h PRN pain. Metformin XR 500 mg BID was discontinued. Patient says codeine caused nausea. Also takes a GLP-1 medication but cannot recall the name.",
      pdfBase64: "JVBERi0xLjQK",
    });

    assert.deepEqual(result.assignments.map(({ name, value, confidence }) => ({
      name,
      value,
      confidence,
    })), [
      { name: "thyroidMedication", value: "Levothyroxine", confidence: 0.69 },
      { name: "thyroidStrength", value: "50 mcg", confidence: 0.99 },
      { name: "thyroidRoute", value: "Oral", confidence: 0.69 },
      { name: "thyroidFrequency", value: "Once daily", confidence: 0.69 },
      { name: "analgesicMedication", value: "Acetaminophen", confidence: 0.69 },
      { name: "analgesicFrequency", value: "Every 6 hours as needed", confidence: 0.69 },
      { name: "metforminFormulation", value: "Extended-release", confidence: 0.69 },
      { name: "currentMetformin", value: null, confidence: 0 },
      { name: "codeineAllergy", value: null, confidence: 0 },
      { name: "specificGlp1Medication", value: null, confidence: 0 },
    ]);
    for (const assignment of result.assignments.slice(0, 7)) {
      assert.ok(assignment.sourceText);
      assert.equal(assignment.evidenceType, "record_documentation");
    }
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

test("disability context maps explicit function while preserving evidence provenance", async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  global.fetch = async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    const requestBody = JSON.parse(options.body);
    assert.match(requestBody.system, /activities of daily living \(ADLs\)/);
    assert.match(requestBody.system, /cannot stand longer than 10 minutes/);
    assert.match(requestBody.system, /diagnosis, impairment, or symptom does not by itself prove disability/);
    assert.match(requestBody.system, /patient-reported limitations distinct from clinician-observed findings/);
    assert.match(requestBody.system, /accommodation or modified duty distinct from inability to work/);
    assert.match(requestBody.system, /Do not decide legal, insurance, workplace, tax-credit, or benefit eligibility/);

    const assignmentSchema = requestBody.output_config.format.schema
      .properties.assignments.items;
    assert.deepEqual(assignmentSchema.properties.evidenceType.enum, [
      "patient_report",
      "clinician_observation",
      "record_documentation",
      "not_applicable",
    ]);

    return {
      ok: true,
      headers: { get: () => "request-disability-test" },
      json: async () => ({
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{
          type: "text",
          text: JSON.stringify({
            assignments: [
              {
                name: "bathing",
                value: "Needs assistance",
                confidence: 0.98,
                matchType: "semantic",
                sourceText: "needs help bathing and dressing",
                evidenceType: "patient_report",
              },
              {
                name: "standingTolerance",
                value: "Less than 15 minutes",
                confidence: 0.97,
                matchType: "semantic",
                sourceText: "cannot stand longer than 10 minutes",
                evidenceType: "patient_report",
              },
              {
                name: "mobilityAid",
                value: "Walker",
                confidence: 0.99,
                matchType: "semantic",
                sourceText: "uses a walker",
                evidenceType: "patient_report",
              },
              {
                name: "episodicLimitation",
                value: true,
                confidence: 0.96,
                matchType: "semantic",
                sourceText: "Symptoms flare unpredictably",
                evidenceType: "patient_report",
              },
              {
                name: "concentrationTolerance",
                value: "20 minutes",
                confidence: 0.95,
                matchType: "semantic",
                sourceText: "concentrate for about 20 minutes at a time",
                evidenceType: "patient_report",
              },
              {
                name: "workAccommodation",
                value: "Work from home; unable to commute",
                confidence: 0.94,
                matchType: "semantic",
                sourceText: "can work from home but cannot commute",
                evidenceType: "patient_report",
              },
              {
                name: "objectiveMobilityFinding",
                value: "Abnormal gait",
                confidence: 0,
                matchType: "unsupported",
                sourceText: null,
                evidenceType: "not_applicable",
              },
              {
                name: "benefitEligibility",
                value: "Eligible",
                confidence: 0,
                matchType: "unsupported",
                sourceText: null,
                evidenceType: "not_applicable",
              },
            ],
          }),
        }],
      }),
    };
  };

  try {
    const result = await mapFieldsWithClaude({
      fields: [
        { name: "bathing", type: "Dropdown", options: ["Independent", "Needs assistance", "Unable"] },
        { name: "standingTolerance", type: "Dropdown", options: ["Less than 15 minutes", "15-30 minutes", "More than 30 minutes"] },
        { name: "mobilityAid", type: "TextField", options: [] },
        { name: "episodicLimitation", type: "CheckBox", options: [] },
        { name: "concentrationTolerance", type: "TextField", options: [] },
        { name: "workAccommodation", type: "TextField", options: [] },
        { name: "objectiveMobilityFinding", type: "TextField", options: [] },
        { name: "benefitEligibility", type: "Dropdown", options: ["Eligible", "Not eligible"] },
      ],
      freeText: "Patient reports she needs help bathing and dressing, cannot stand longer than 10 minutes, and uses a walker. Symptoms flare unpredictably. She can work from home but cannot commute and can concentrate for about 20 minutes at a time.",
      pdfBase64: "JVBERi0xLjQK",
    });

    assert.deepEqual(result.assignments.slice(0, 6).map((assignment) => ({
      name: assignment.name,
      value: assignment.value,
      confidence: assignment.confidence,
      evidenceType: assignment.evidenceType,
      semanticMatch: assignment.semanticMatch,
    })), [
      { name: "bathing", value: "Needs assistance", confidence: 0.69, evidenceType: "patient_report", semanticMatch: true },
      { name: "standingTolerance", value: "Less than 15 minutes", confidence: 0.69, evidenceType: "patient_report", semanticMatch: true },
      { name: "mobilityAid", value: "Walker", confidence: 0.69, evidenceType: "patient_report", semanticMatch: true },
      { name: "episodicLimitation", value: true, confidence: 0.69, evidenceType: "patient_report", semanticMatch: true },
      { name: "concentrationTolerance", value: "20 minutes", confidence: 0.69, evidenceType: "patient_report", semanticMatch: true },
      { name: "workAccommodation", value: "Work from home; unable to commute", confidence: 0.69, evidenceType: "patient_report", semanticMatch: true },
    ]);
    assert.deepEqual(result.assignments.slice(6), [
      { name: "objectiveMobilityFinding", value: null, confidence: 0 },
      { name: "benefitEligibility", value: null, confidence: 0 },
    ]);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

test("unsupported clinical interpretations and unverified evidence remain blank", async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  global.fetch = async () => ({
    ok: true,
    headers: { get: () => "request-safety-test" },
    json: async () => ({
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      content: [{
        type: "text",
        text: JSON.stringify({
          assignments: [
            {
              name: "patientDiagnosis",
              value: "Hypertension",
              confidence: 0.9,
              matchType: "unsupported",
              sourceText: null,
              evidenceType: "not_applicable",
            },
            {
              name: "currentMedication",
              value: "Metformin",
              confidence: 0.9,
              matchType: "unsupported",
              sourceText: null,
              evidenceType: "not_applicable",
            },
            {
              name: "allergy",
              value: "Codeine",
              confidence: 0.9,
              matchType: "unsupported",
              sourceText: null,
              evidenceType: "not_applicable",
            },
            {
              name: "confirmedDiagnosis",
              value: "Pneumonia",
              confidence: 0.9,
              matchType: "unsupported",
              sourceText: null,
              evidenceType: "not_applicable",
            },
            {
              name: "phone",
              value: "905-555-0100",
              confidence: 1,
              matchType: "exact",
              sourceText: "a phone number that is not in the note",
              evidenceType: "record_documentation",
            },
          ],
        }),
      }],
    }),
  });

  try {
    const result = await mapFieldsWithClaude({
      fields: [
        { name: "patientDiagnosis", type: "TextField", options: [] },
        { name: "currentMedication", type: "TextField", options: [] },
        { name: "allergy", type: "TextField", options: [] },
        { name: "confirmedDiagnosis", type: "TextField", options: [] },
        { name: "phone", type: "TextField", options: [] },
      ],
      freeText: "Family history: hypertension. Metformin discontinued. Codeine caused nausea. Possible pneumonia.",
      pdfBase64: "JVBERi0xLjQK",
    });

    assert.deepEqual(result.assignments, [
      { name: "patientDiagnosis", value: null, confidence: 0 },
      { name: "currentMedication", value: null, confidence: 0 },
      { name: "allergy", value: null, confidence: 0 },
      { name: "confirmedDiagnosis", value: null, confidence: 0 },
      { name: "phone", value: null, confidence: 0 },
    ]);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});
