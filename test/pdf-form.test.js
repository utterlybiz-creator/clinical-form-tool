import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { fillPdfForm, inspectPdfForm } from "../src/pdf-form.js";

async function createTestForm() {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();

  const name = form.createTextField("patient.name");
  name.setMaxLength(40);
  name.addToPage(page, { x: 50, y: 700, width: 220, height: 24 });

  const notes = form.createTextField("clinical.notes");
  notes.enableMultiline();
  notes.addToPage(page, { x: 50, y: 600, width: 400, height: 80 });

  const consent = form.createCheckBox("patient.consent");
  consent.addToPage(page, { x: 50, y: 560, width: 18, height: 18 });

  const sex = form.createRadioGroup("patient.sex");
  sex.addOptionToPage("Female", page, { x: 50, y: 520, width: 18, height: 18 });
  sex.addOptionToPage("Male", page, { x: 110, y: 520, width: 18, height: 18 });

  const province = form.createDropdown("patient.province");
  province.addOptions(["Ontario", "British Columbia"]);
  province.addToPage(page, { x: 50, y: 470, width: 180, height: 24 });

  const symptoms = form.createOptionList("clinical.symptoms");
  symptoms.addOptions(["Fatigue", "Pain", "Nausea"]);
  symptoms.enableMultiselect();
  symptoms.addToPage(page, { x: 50, y: 350, width: 180, height: 100 });

  return document.save({ useObjectStreams: false });
}

test("inspectPdfForm describes supported AcroForm fields", async () => {
  const pdf = await createTestForm();
  const inspection = await inspectPdfForm(pdf);

  assert.equal(inspection.pageCount, 1);
  assert.equal(inspection.fields.length, 6);
  assert.deepEqual(
    inspection.fields
      .map(({ name, type }) => ({ name, type }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    [
      { name: "clinical.notes", type: "TextField" },
      { name: "clinical.symptoms", type: "OptionList" },
      { name: "patient.consent", type: "CheckBox" },
      { name: "patient.name", type: "TextField" },
      { name: "patient.province", type: "Dropdown" },
      { name: "patient.sex", type: "RadioGroup" },
    ],
  );
  assert.deepEqual(
    inspection.fields.find((field) => field.name === "patient.province").options,
    ["Ontario", "British Columbia"],
  );
  assert.equal(
    inspection.fields.find((field) => field.name === "clinical.notes").multiline,
    true,
  );
});

test("fillPdfForm fills text, checkbox, radio, dropdown, and option-list values", async () => {
  const pdf = await createTestForm();
  const completed = await fillPdfForm(pdf, [
    { name: "patient.name", value: "Test Patient" },
    { name: "clinical.notes", value: "Follow-up appointment." },
    { name: "patient.consent", value: true },
    { name: "patient.sex", value: "Female" },
    { name: "patient.province", value: "ontario" },
    { name: "clinical.symptoms", value: ["Fatigue", "Pain"] },
  ]);

  assert.equal(completed.issues.length, 0);
  assert.equal(completed.filledFields.length, 6);

  const output = await PDFDocument.load(completed.pdfBytes);
  const form = output.getForm();
  assert.equal(form.getTextField("patient.name").getText(), "Test Patient");
  assert.equal(form.getTextField("clinical.notes").getText(), "Follow-up appointment.");
  assert.equal(form.getCheckBox("patient.consent").isChecked(), true);
  assert.equal(form.getRadioGroup("patient.sex").getSelected(), "Female");
  assert.deepEqual(form.getDropdown("patient.province").getSelected(), ["Ontario"]);
  assert.deepEqual(form.getOptionList("clinical.symptoms").getSelected(), ["Fatigue", "Pain"]);
});

test("fillPdfForm reports invalid and overlength values without silently truncating", async () => {
  const pdf = await createTestForm();
  const completed = await fillPdfForm(pdf, [
    { name: "patient.name", value: "x".repeat(41) },
    { name: "patient.province", value: "Alberta" },
    { name: "missing.field", value: "value" },
  ]);

  assert.equal(completed.filledFields.length, 0);
  assert.equal(completed.issues.length, 3);
  assert.match(completed.issues[0].message, /allows 40/i);
  assert.match(completed.issues[1].message, /dropdown options/i);
  assert.match(completed.issues[2].message, /no longer exists/i);
});

test("fillPdfForm can flatten completed fields", async () => {
  const pdf = await createTestForm();
  const completed = await fillPdfForm(
    pdf,
    [{ name: "patient.name", value: "Test Patient" }],
    { flatten: true },
  );
  const output = await PDFDocument.load(completed.pdfBytes);
  assert.equal(output.getForm().getFields().length, 0);
});

test("inspectPdfForm rejects PDFs without fillable fields", async () => {
  const document = await PDFDocument.create();
  document.addPage([300, 300]);
  const pdf = await document.save();

  await assert.rejects(
    () => inspectPdfForm(pdf),
    /no fillable AcroForm fields/i,
  );
});
