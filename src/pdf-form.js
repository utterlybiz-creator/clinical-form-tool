import {
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
} from "pdf-lib";

export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;

function copyPdfBytes(source) {
  if (source instanceof Uint8Array) return new Uint8Array(source);
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  throw new TypeError("PDF data must be an ArrayBuffer or Uint8Array.");
}

export function getFieldType(field) {
  if (field instanceof PDFTextField) return "TextField";
  if (field instanceof PDFCheckBox) return "CheckBox";
  if (field instanceof PDFRadioGroup) return "RadioGroup";
  if (field instanceof PDFDropdown) return "Dropdown";
  if (field instanceof PDFOptionList) return "OptionList";
  if (field instanceof PDFSignature) return "Signature";
  if (field instanceof PDFButton) return "Button";
  return "Unknown";
}

function safeCall(callback, fallback) {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

export function describeField(field) {
  const type = getFieldType(field);
  const description = {
    name: field.getName(),
    type,
    options: [],
    readOnly: safeCall(() => field.isReadOnly(), false),
    required: safeCall(() => field.isRequired(), false),
    supported: !["Signature", "Button", "Unknown"].includes(type),
  };

  if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
    description.options = safeCall(() => field.getOptions(), []);
  }
  if (field instanceof PDFTextField) {
    description.maxLength = safeCall(() => field.getMaxLength(), undefined);
    description.multiline = safeCall(() => field.isMultiline(), false);
  }
  if (field instanceof PDFOptionList) {
    description.multiselect = safeCall(() => field.isMultiselect(), false);
  }

  return description;
}

export async function inspectPdfForm(pdfData) {
  let pdfDocument;
  try {
    pdfDocument = await PDFDocument.load(copyPdfBytes(pdfData), { ignoreEncryption: false });
  } catch (error) {
    if (/encrypt/i.test(error.message)) {
      throw new Error("This PDF is password-protected and cannot be completed.");
    }
    throw new Error(`The PDF could not be opened: ${error.message}`);
  }

  const form = pdfDocument.getForm();
  const fields = form.getFields().map(describeField);
  if (fields.length === 0) {
    throw new Error(
      "This PDF has no fillable AcroForm fields. It may be a scanned or flattened form and needs a coordinate-based filling mode.",
    );
  }

  return {
    fields,
    pageCount: pdfDocument.getPageCount(),
    hasXfa: safeCall(() => form.hasXFA(), false),
  };
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLocaleLowerCase();
  if (["true", "yes", "y", "1", "on", "checked", "x"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "off", "unchecked"].includes(normalized)) return false;
  return null;
}

function exactOption(value, options) {
  if (typeof value !== "string") return null;
  if (options.includes(value)) return value;
  const normalized = value.trim().toLocaleLowerCase();
  const matches = options.filter((option) => option.trim().toLocaleLowerCase() === normalized);
  return matches.length === 1 ? matches[0] : null;
}

function setFieldValue(field, value) {
  if (field instanceof PDFTextField) {
    const text = typeof value === "string" ? value : String(value);
    const maxLength = field.getMaxLength();
    if (maxLength !== undefined && text.length > maxLength) {
      throw new Error(`Value is ${text.length} characters; this field allows ${maxLength}.`);
    }
    field.setText(text);
    return;
  }

  if (field instanceof PDFCheckBox) {
    const checked = normalizeBoolean(value);
    if (checked === null) throw new Error("Expected a yes/no checkbox value.");
    if (checked) field.check();
    else field.uncheck();
    return;
  }

  if (field instanceof PDFRadioGroup) {
    const option = exactOption(value, field.getOptions());
    if (!option) throw new Error("Value is not one of the radio-group options.");
    field.select(option);
    return;
  }

  if (field instanceof PDFDropdown) {
    const option = exactOption(value, field.getOptions());
    if (!option) throw new Error("Value is not one of the dropdown options.");
    field.select(option);
    return;
  }

  if (field instanceof PDFOptionList) {
    const requested = Array.isArray(value) ? value : [value];
    const options = requested.map((item) => exactOption(item, field.getOptions()));
    if (options.some((option) => !option)) {
      throw new Error("One or more values are not valid list options.");
    }
    if (!field.isMultiselect() && options.length > 1) {
      throw new Error("This option list allows only one selection.");
    }
    field.select(options);
    return;
  }

  if (field instanceof PDFSignature) {
    throw new Error("Digital signatures require an authorized signing workflow and are never filled automatically.");
  }
  if (field instanceof PDFButton) {
    throw new Error("Button fields do not contain clinical values.");
  }

  throw new Error("Unsupported PDF field type.");
}

export async function fillPdfForm(pdfData, assignments, { flatten = false } = {}) {
  const pdfDocument = await PDFDocument.load(copyPdfBytes(pdfData), { ignoreEncryption: false });
  const form = pdfDocument.getForm();
  const fields = form.getFields();
  const fieldByName = new Map(fields.map((field) => [field.getName(), field]));
  const filledFields = [];
  const issues = [];

  for (const assignment of assignments) {
    if (!assignment || assignment.value === null || assignment.value === undefined || assignment.value === "") {
      continue;
    }

    const field = fieldByName.get(assignment.name);
    if (!field) {
      issues.push({ name: assignment.name || "Unknown", message: "Field no longer exists in the PDF." });
      continue;
    }

    try {
      setFieldValue(field, assignment.value);
      filledFields.push(assignment.name);
    } catch (error) {
      issues.push({ name: assignment.name, message: error.message });
    }
  }

  try {
    form.updateFieldAppearances();
    if (flatten) form.flatten({ updateFieldAppearances: false });
  } catch (error) {
    throw new Error(`The PDF field appearances could not be generated: ${error.message}`);
  }

  const pdfBytes = await pdfDocument.save({ useObjectStreams: false });
  return { pdfBytes, filledFields, issues, totalFields: fields.length };
}

export function fileToArrayBuffer(file) {
  return file.arrayBuffer();
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma === -1) reject(new Error("The PDF could not be encoded."));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("The PDF could not be read."));
    reader.readAsDataURL(file);
  });
}
