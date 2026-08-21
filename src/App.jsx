import { useEffect, useMemo, useState } from "react";
import "./styles.css";

const LOW_CONFIDENCE = 0.7;
const MAX_PDF_SIZE_BYTES = 3 * 1024 * 1024;
const EVIDENCE_LABELS = {
  patient_report: "Patient reported",
  clinician_observation: "Clinician observed",
  record_documentation: "Documented in note",
};

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function friendlyError(error) {
  if (error?.name === "AbortError") return "The AI request timed out. Please try again.";
  return error?.message || "An unexpected error occurred.";
}

async function postFieldMapping(payload, signal) {
  const response = await fetch("/api/map-fields", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The server returned an unreadable response (${response.status}).`);
  }

  if (!response.ok) {
    const requestSuffix = data.requestId ? ` Request ID: ${data.requestId}` : "";
    throw new Error(`${data.error || `Request failed (${response.status}).`}${requestSuffix}`);
  }
  if (!Array.isArray(data.assignments)) {
    throw new Error("The server returned no field assignments.");
  }
  return data;
}

function FieldEditor({ field, assignment, onChange }) {
  const inputId = `field-${field.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const confidence = assignment.confidence || 0;
  const hasValue = assignment.value !== null && assignment.value !== "";
  const evidenceLabel = EVIDENCE_LABELS[assignment.evidenceType] || "Documented in note";

  let editor;
  if (!field.supported) {
    editor = <div className="unsupported">Not completed automatically</div>;
  } else if (field.type === "CheckBox") {
    const selected = assignment.value === true ? "yes" : assignment.value === false ? "no" : "";
    editor = (
      <select
        id={inputId}
        value={selected}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value === "yes")}
      >
        <option value="">Not specified</option>
        <option value="yes">Checked / Yes</option>
        <option value="no">Unchecked / No</option>
      </select>
    );
  } else if (field.type === "RadioGroup" || field.type === "Dropdown") {
    editor = (
      <select id={inputId} value={assignment.value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">Not specified</option>
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  } else if (field.type === "OptionList") {
    const values = Array.isArray(assignment.value)
      ? assignment.value
      : assignment.value ? [assignment.value] : [];
    editor = (
      <select
        id={inputId}
        multiple={Boolean(field.multiselect)}
        value={field.multiselect ? values : values[0] || ""}
        onChange={(event) => {
          if (field.multiselect) {
            onChange(Array.from(event.target.selectedOptions, (option) => option.value));
          } else {
            onChange(event.target.value ? [event.target.value] : null);
          }
        }}
      >
        {!field.multiselect && <option value="">Not specified</option>}
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  } else if (field.multiline) {
    editor = (
      <textarea
        id={inputId}
        rows="3"
        maxLength={field.maxLength}
        value={assignment.value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      />
    );
  } else {
    editor = (
      <input
        id={inputId}
        type="text"
        maxLength={field.maxLength}
        value={assignment.value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      />
    );
  }

  return (
    <div className={`field-row ${hasValue && confidence < LOW_CONFIDENCE ? "low-confidence" : ""}`}>
      <div className="field-heading">
        <label htmlFor={field.supported ? inputId : undefined}>{field.name}</label>
        <div className="field-badges">
          <span>{field.type}</span>
          {field.required && <span>Required</span>}
          {assignment.semanticMatch && !assignment.edited && (
            <span className="semantic-badge">Healthcare semantic match — confirm</span>
          )}
          {hasValue && <span>{Math.round(confidence * 100)}% AI confidence</span>}
        </div>
      </div>
      {editor}
      {assignment.sourceText && !assignment.edited && (
        <div className="source-evidence">
          <strong>Matched from note ({evidenceLabel}):</strong> <q>{assignment.sourceText}</q>
        </div>
      )}
      {field.maxLength && <small>Maximum {field.maxLength} characters</small>}
    </div>
  );
}

export default function App() {
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfBuffer, setPdfBuffer] = useState(null);
  const [freeText, setFreeText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState("input");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [formInfo, setFormInfo] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [filter, setFilter] = useState("mapped");
  const [flatten, setFlatten] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => () => {
    if (result?.downloadUrl) URL.revokeObjectURL(result.downloadUrl);
  }, [result]);

  const assignmentByName = useMemo(
    () => new Map(assignments.map((assignment) => [assignment.name, assignment])),
    [assignments],
  );

  const mappedCount = assignments.filter(
    (assignment) => assignment.value !== null && assignment.value !== "",
  ).length;
  const lowConfidenceCount = assignments.filter(
    (assignment) => assignment.value !== null && assignment.value !== "" && assignment.confidence < LOW_CONFIDENCE,
  ).length;

  const visibleFields = useMemo(() => {
    if (!formInfo) return [];
    if (filter === "all") return formInfo.fields;
    if (filter === "review") {
      return formInfo.fields.filter((field) => {
        const assignment = assignmentByName.get(field.name);
        return !field.supported || (assignment?.value !== null && assignment?.confidence < LOW_CONFIDENCE);
      });
    }
    return formInfo.fields.filter((field) => {
      const value = assignmentByName.get(field.name)?.value;
      return value !== null && value !== "";
    });
  }, [assignmentByName, filter, formInfo]);

  const canAnalyze = Boolean(pdfFile && freeText.trim().length >= 2 && phase !== "loading");

  const chooseFile = (file) => {
    setError("");
    if (!file) return;
    const looksLikePdf = file.type === "application/pdf" || file.name.toLocaleLowerCase().endsWith(".pdf");
    if (!looksLikePdf) {
      setError("Please choose a PDF file.");
      return;
    }
    if (file.size > MAX_PDF_SIZE_BYTES) {
      setError("The PDF must be smaller than 3 MB for secure processing on this service.");
      return;
    }
    setPdfFile(file);
    setPdfBuffer(null);
    setFormInfo(null);
    setAssignments([]);
    setResult(null);
    setPhase("input");
  };

  const analyze = async () => {
    if (!canAnalyze) return;
    setPhase("loading");
    setError("");
    setResult(null);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 120_000);

    try {
      setProgress("Inspecting fillable PDF fields...");
      const {
        fileToArrayBuffer,
        fileToBase64,
        inspectPdfForm,
      } = await import("./pdf-form.js");
      const [buffer, base64] = await Promise.all([
        fileToArrayBuffer(pdfFile),
        fileToBase64(pdfFile),
      ]);
      const inspection = await inspectPdfForm(buffer);

      setProgress("Claude is matching the clinical notes to the form...");
      const response = await postFieldMapping({
        pdfBase64: base64,
        freeText: freeText.trim(),
        fields: inspection.fields.map(({ name, type, options }) => ({ name, type, options })),
      }, controller.signal);

      const returnedByName = new Map(response.assignments.map((assignment) => [assignment.name, assignment]));
      setPdfBuffer(buffer);
      setFormInfo({ ...inspection, model: response.model });
      setAssignments(inspection.fields.map((field) => returnedByName.get(field.name) || {
        name: field.name,
        value: null,
        confidence: 0,
      }));
      setFilter("mapped");
      setPhase("review");
    } catch (caught) {
      setError(friendlyError(caught));
      setPhase("input");
    } finally {
      window.clearTimeout(timeout);
      setProgress("");
    }
  };

  const updateAssignment = (name, value) => {
    setAssignments((current) => current.map((assignment) => (
      assignment.name === name
        ? {
          ...assignment,
          value,
          confidence: 1,
          semanticMatch: false,
          sourceText: null,
          evidenceType: null,
          edited: true,
        }
        : assignment
    )));
  };

  const generatePdf = async () => {
    if (!pdfBuffer) return;
    setPhase("loading");
    setError("");
    setProgress("Generating the completed PDF...");

    try {
      const { fillPdfForm } = await import("./pdf-form.js");
      const completed = await fillPdfForm(pdfBuffer, assignments, { flatten });
      const blob = new Blob([completed.pdfBytes], { type: "application/pdf" });
      const downloadUrl = URL.createObjectURL(blob);
      setResult({ ...completed, downloadUrl });
      setPhase("done");
    } catch (caught) {
      setError(friendlyError(caught));
      setPhase("review");
    } finally {
      setProgress("");
    }
  };

  const download = () => {
    if (!result || !pdfFile) return;
    const link = document.createElement("a");
    link.href = result.downloadUrl;
    link.download = `completed_${pdfFile.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const startOver = () => {
    if (result?.downloadUrl) URL.revokeObjectURL(result.downloadUrl);
    setPdfFile(null);
    setPdfBuffer(null);
    setFreeText("");
    setFormInfo(null);
    setAssignments([]);
    setResult(null);
    setError("");
    setPhase("input");
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">AF</div>
        <div>
          <h1>Clinical Form Completion Tool</h1>
          <p>Upload a fillable form, map your notes, review every value, and download the PDF.</p>
        </div>
      </header>

      <main>
        <div className="privacy-notice">
          <strong>Clinical privacy:</strong> The API key stays on the server. Use identifiable patient information only after your deployment and Anthropic account have been approved for your privacy, retention, and contractual requirements.
        </div>

        {(phase === "input" || phase === "loading" && !formInfo) && (
          <section className="input-grid" aria-label="Form inputs">
            <article className="card">
              <h2>1. PDF form</h2>
              <div
                className={`drop-zone ${dragging ? "dragging" : ""}`}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  chooseFile(event.dataTransfer.files[0]);
                }}
              >
                <span className="drop-icon" aria-hidden="true">PDF</span>
                <p>Drop a fillable PDF here or choose a file.</p>
                <label className="secondary-button">
                  Choose PDF
                  <input type="file" accept="application/pdf,.pdf" onChange={(event) => chooseFile(event.target.files[0])} />
                </label>
                <small>Maximum size: 20 MB</small>
              </div>
              {pdfFile && (
                <div className="selected-file">
                  <span><strong>{pdfFile.name}</strong><small>{formatBytes(pdfFile.size)}</small></span>
                  <button type="button" onClick={() => setPdfFile(null)}>Remove</button>
                </div>
              )}
            </article>

            <article className="card">
              <h2>2. Clinical notes</h2>
              <label className="sr-only" htmlFor="clinical-notes">Clinical notes</label>
              <textarea
                id="clinical-notes"
                className="notes-input"
                placeholder={"Example: 52F, HTN and DM2. Follow-up. BP 136/82. A1c 7.1%. No medication allergies."}
                value={freeText}
                onChange={(event) => setFreeText(event.target.value)}
                maxLength="50000"
              />
              <div className="character-count">{freeText.length.toLocaleString()} / 50,000</div>
            </article>

            <button className="primary-button full-width" type="button" onClick={analyze} disabled={!canAnalyze}>
              Analyze and prepare review
            </button>
          </section>
        )}

        {progress && <div className="progress" role="status"><span className="spinner" />{progress}</div>}
        {error && <div className="error-box" role="alert">{error}</div>}

        {(phase === "review" || phase === "loading" && formInfo) && formInfo && (
          <section className="review-section">
            <div className="review-header">
              <div>
                <p className="eyebrow">Human review required</p>
                <h2>Review the proposed field values</h2>
                <p>{mappedCount} of {formInfo.fields.length} fields have proposed values. {lowConfidenceCount} require closer review.</p>
              </div>
              <button className="text-button" type="button" onClick={startOver}>Start over</button>
            </div>

            {formInfo.hasXfa && <div className="warning-box">This PDF contains XFA data. Verify the downloaded result in Adobe Acrobat because XFA behavior varies between viewers.</div>}

            <div className="filter-bar" role="group" aria-label="Filter fields">
              <button className={filter === "mapped" ? "active" : ""} onClick={() => setFilter("mapped")}>Mapped ({mappedCount})</button>
              <button className={filter === "review" ? "active" : ""} onClick={() => setFilter("review")}>Needs review ({lowConfidenceCount})</button>
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All ({formInfo.fields.length})</button>
            </div>

            <div className="field-list">
              {visibleFields.length === 0 ? (
                <div className="empty-state">No fields match this filter.</div>
              ) : visibleFields.map((field) => (
                <FieldEditor
                  key={field.name}
                  field={field}
                  assignment={assignmentByName.get(field.name) || { value: null, confidence: 0 }}
                  onChange={(value) => updateAssignment(field.name, value)}
                />
              ))}
            </div>

            <div className="completion-options">
              <label>
                <input type="checkbox" checked={flatten} onChange={(event) => setFlatten(event.target.checked)} />
                Flatten fields after filling
              </label>
              <small>Flattening prevents ordinary PDF editors from changing completed fields. Leave this off if you want the PDF to remain editable.</small>
            </div>

            <button className="primary-button full-width" type="button" onClick={generatePdf} disabled={phase === "loading"}>
              Generate completed PDF
            </button>
          </section>
        )}

        {phase === "done" && result && (
          <section className="result-card">
            <p className="eyebrow">PDF generated</p>
            <h2>Completion summary</h2>
            <div className="summary-grid">
              <div><strong>{result.filledFields.length}</strong><span>Fields filled</span></div>
              <div><strong>{result.issues.length}</strong><span>Filling issues</span></div>
              <div><strong>{result.totalFields}</strong><span>Total fields</span></div>
            </div>
            {result.issues.length > 0 && (
              <div className="issue-list">
                <strong>Review these fields:</strong>
                <ul>{result.issues.map((issue) => <li key={`${issue.name}-${issue.message}`}><b>{issue.name}:</b> {issue.message}</li>)}</ul>
              </div>
            )}
            <div className="result-actions">
              <button className="primary-button" type="button" onClick={download}>Download completed PDF</button>
              <button className="secondary-button" type="button" onClick={() => setPhase("review")}>Return to review</button>
              <button className="text-button" type="button" onClick={startOver}>Start over</button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
