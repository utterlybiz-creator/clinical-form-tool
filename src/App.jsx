import { useState, useCallback } from "react";
import { PDFDocument } from "pdf-lib";

const TEAL = "#0B6E6E";
const TEAL_LIGHT = "#E6F4F4";
const NAVY = "#0D2B45";
const CREAM = "#FAF8F4";
const GOLD = "#C49A3C";
const RED = "#C0392B";

function fileToArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function pdfToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function fillPdf(pdfArrayBuffer, fieldMap) {
  const pdfDoc = await PDFDocument.load(pdfArrayBuffer, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const filledFields = [];
  const skippedFields = [];

  for (const field of fields) {
    const fieldName = field.getName();
    const value = fieldMap[fieldName];
    if (value === null || value === undefined || value === "") {
      skippedFields.push(fieldName);
      continue;
    }try {
      const typeName = field.constructor.name;
      if (typeName === "PDFTextField") {
        const safeVal = value === null || value === undefined ? "" : String(value);
        field.setText(safeVal);
        filledFields.push(fieldName);
      } else if (typeName === "PDFCheckBox") {
        if (value === true || value === "true" || value === "yes" || value === "Yes") {
          field.check();
        } else {
          field.uncheck();
        }
        filledFields.push(fieldName);
      } else if (typeName === "PDFRadioGroup") {
        try {
          const options = field.getOptions();
          const strVal = String(value);
          if (options.length > 0 && options.includes(strVal)) {
            field.select(strVal);
            filledFields.push(fieldName);
          } else {
            skippedFields.push(fieldName);
          }
        } catch {
          skippedFields.push(fieldName);
        }
      } else {
        skippedFields.push(fieldName);
      }
    } catch {
      skippedFields.push(fieldName);
    }
  }

  const pdfBytes = await pdfDoc.save();
  return { pdfBytes, filledFields, skippedFields, totalFields: fields.length };
}

export default function App() {
  const [pdfFile, setPdfFile] = useState(null);
  const [freeText, setFreeText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type === "application/pdf") setPdfFile(file);
  }, []);

  const canRun = pdfFile && freeText.trim().length > 10 && !loading && apiKey.trim().length > 10;

  const run = async () => {
    if (!canRun) return;
    setLoading(true);
    setError("");
    setResult(null);

    try {
      setProgress("Reading PDF form...");
      const arrayBuffer = await fileToArrayBuffer(pdfFile);
      const base64 = await pdfToBase64(pdfFile);

      const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
      const form = pdfDoc.getForm();
      const fields = form.getFields();

      const fieldDescriptions = fields.map(f => {
        const name = f.getName();
        const type = f.constructor.name.replace("PDF", "");
        let options = "";
        if (type === "RadioGroup") {
          try { options = ` [options: ${f.getOptions().join(", ")}]`; } catch {}
        }
        return `${name} (${type})${options}`;
      }).join("\n");

      setProgress("AI is reading the form and matching your notes...");

      const systemPrompt = `You are a clinical documentation assistant helping a Nurse Practitioner complete a medical form.
You will receive:
1. The PDF form as a document (so you can see the visual layout and labels)
2. A list of all PDF field names with their types
3. Clinical notes from the NP

Your job is to map the clinical information to the correct PDF fields by understanding the visual form layout and matching field positions to their labels.

For text fields: provide the text value.
For checkboxes: provide true or false.
For radio groups: provide the exact option value to select.
Leave fields null if the information is not available in the clinical notes.

Respond ONLY with a valid JSON object where keys are the EXACT field names and values are what to fill in. No markdown, no explanation.`;

      const userMessage = `PDF Field Names and Types:
${fieldDescriptions}

Clinical Notes:
${freeText}

Return a JSON object mapping each field name to its value based on the clinical notes and the visual form layout you can see in the PDF.`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 4000,
          system: systemPrompt,
          messages: [{
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: base64 },
              },
              { type: "text", text: userMessage }
            ]
          }],
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message);

      const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
      const clean = text.replace(/```json|```/g, "").trim();
      const fieldMap = JSON.parse(clean);

      setProgress("Filling PDF...");
      const { pdfBytes, filledFields, skippedFields, totalFields } = await fillPdf(arrayBuffer, fieldMap);

      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const downloadUrl = URL.createObjectURL(blob);

      setProgress("");
      setResult({ downloadUrl, fileName: pdfFile.name, filledFields, skippedFields, totalFields });

    } catch (err) {
      setProgress("");
      setError(err.message.includes("JSON")
        ? "Unexpected AI response. Please try again."
        : `Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const download = () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = result.downloadUrl;
    a.download = `completed_${result.fileName}`;
    a.click();
  };

  return (
    <div style={{ minHeight: "100vh", background: CREAM, fontFamily: "Georgia, serif" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={{ background: NAVY, padding: "28px 40px", display: "flex", alignItems: "center", gap: 16, borderBottom: `4px solid ${GOLD}` }}>
        <div style={{ width: 44, height: 44, background: GOLD, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>📋</div>
        <div>
          <h1 style={{ color: "#fff", fontSize: 22, fontWeight: "bold", margin: 0 }}>Clinical Form Completion Tool</h1>
          <div style={{ color: "#9BB5C8", fontSize: 13, fontFamily: "sans-serif" }}>Upload a form · Add your clinical notes · Download completed PDF</div>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "40px 24px" }}>

        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #DDE4EB", padding: 24, marginBottom: 24, boxShadow: "0 2px 12px rgba(13,43,69,0.06)" }}>
          <div style={{ color: NAVY, fontSize: 13, fontWeight: "bold", fontFamily: "sans-serif", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>🔑 Anthropic API Key</div>
          <input
            type="password"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            style={{ width: "100%", border: "1.5px solid #DDE4EB", borderRadius: 8, padding: "12px 16px", fontFamily: "sans-serif", fontSize: 14, color: NAVY, outline: "none", boxSizing: "border-box" }}
          />
          <div style={{ fontSize: 12, color: "#8A9BAA", fontFamily: "sans-serif", marginTop: 8 }}>
            Get your key at console.anthropic.com — stays in your browser, never stored.
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #DDE4EB", padding: 28, boxShadow: "0 2px 12px rgba(13,43,69,0.06)" }}>
            <div style={{ color: NAVY, fontSize: 13, fontWeight: "bold", fontFamily: "sans-serif", textTransform: "uppercase", letterSpacing: 1, marginBottom: 16 }}>📄 PDF Form</div>
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              style={{ border: `2px dashed ${dragging ? TEAL : "#B8C8D8"}`, borderRadius: 10, padding: "30px 20px", textAlign: "center", background: dragging ? TEAL_LIGHT : "#F8FBFD", transition: "all 0.2s" }}
            >
              <div style={{ fontSize: 36, marginBottom: 10 }}>📂</div>
              <div style={{ color: "#5A7A8A", fontFamily: "sans-serif", fontSize: 13, marginBottom: 14 }}>
                <strong>Drop your PDF here</strong><br />or click the button below
              </div>
              <label style={{ display: "inline-block", background: TEAL, color: "#fff", borderRadius: 7, padding: "10px 22px", fontFamily: "sans-serif", fontSize: 13, fontWeight: "bold", cursor: "pointer" }}>
                📁 Choose PDF File
                <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={e => setPdfFile(e.target.files[0])} />
              </label>
            </div>
            {pdfFile && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, background: TEAL_LIGHT, border: `1px solid ${TEAL}`, borderRadius: 8, padding: "12px 16px", marginTop: 12 }}>
                <span>📄</span>
                <span style={{ flex: 1, fontSize: 13, color: NAVY, fontFamily: "sans-serif", fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pdfFile.name}</span>
                <button onClick={() => setPdfFile(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#8A9BAA", fontSize: 18 }}>✕</button>
              </div>
            )}
          </div>

          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #DDE4EB", padding: 28, boxShadow: "0 2px 12px rgba(13,43,69,0.06)" }}>
            <div style={{ color: NAVY, fontSize: 13, fontWeight: "bold", fontFamily: "sans-serif", textTransform: "uppercase", letterSpacing: 1, marginBottom: 16 }}>🩺 Clinical Notes</div>
            <textarea
              style={{ width: "100%", minHeight: 200, border: "1.5px solid #DDE4EB", borderRadius: 8, padding: "14px 16px", fontFamily: "Georgia, serif", fontSize: 14, color: NAVY, lineHeight: 1.7, resize: "vertical", outline: "none", boxSizing: "border-box", background: "#FAFBFC" }}
              placeholder={"Type your clinical shorthand here…\n\nExamples:\n• 52F HTN DM2, f/u, BP 136/82, A1c 7.1\n• Referral to cardiology, exertional chest pain"}
              value={freeText}
              onChange={e => setFreeText(e.target.value)}
            />
            <div style={{ fontSize: 12, color: "#8A9BAA", fontFamily: "sans-serif", marginTop: 8 }}>Abbreviations and shorthand are fine.</div>
          </div>
        </div>

        <button
          onClick={run}
          disabled={!canRun}
          style={{ width: "100%", background: canRun ? TEAL : "#B0C4CE", color: "#fff", border: "none", borderRadius: 10, padding: "18px 0", fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold", cursor: canRun ? "pointer" : "not-allowed", marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}
        >
          {loading
            ? <><span style={{ display: "inline-block", width: 18, height: 18, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> Processing...</>
            : "✨ Complete Form with AI"}
        </button>

        {progress && (
          <div style={{ background: "#EEF5F5", borderRadius: 8, padding: "16px 20px", fontFamily: "sans-serif", fontSize: 14, color: TEAL, display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <span style={{ display: "inline-block", width: 16, height: 16, border: "2px solid rgba(11,110,110,0.3)", borderTopColor: TEAL, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
            {progress}
          </div>
        )}

        {error && (
          <div style={{ background: "#FDF2F2", border: `1px solid ${RED}`, borderRadius: 8, padding: "16px 20px", color: RED, fontFamily: "sans-serif", fontSize: 14, marginBottom: 20 }}>
            ⚠️ {error}
          </div>
        )}

        {result && (
          <div style={{ background: "#fff", borderRadius: 12, border: `1.5px solid ${TEAL}`, padding: 28, boxShadow: "0 2px 12px rgba(11,110,110,0.08)" }}>
            <div style={{ color: TEAL, fontSize: 15, fontWeight: "bold", marginBottom: 16, fontFamily: "sans-serif", textTransform: "uppercase", letterSpacing: 1 }}>✅ PDF Completed</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 24 }}>
              <div style={{ background: "#F0FAF0", border: "1px solid #A8D8A8", borderRadius: 8, padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 28, fontWeight: "bold", color: "#2E7D32" }}>{result.filledFields.length}</div>
                <div style={{ fontSize: 12, color: "#4A7A4A", fontFamily: "sans-serif", marginTop: 4 }}>Fields Filled</div>
              </div>
              <div style={{ background: "#FEF9EC", border: "1px solid #E8C96A", borderRadius: 8, padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 28, fontWeight: "bold", color: "#8A6A10" }}>{result.skippedFields.length}</div>
                <div style={{ fontSize: 12, color: "#8A6A10", fontFamily: "sans-serif", marginTop: 4 }}>Need Review</div>
              </div>
              <div style={{ background: "#F0F4FF", border: "1px solid #A8B8E8", borderRadius: 8, padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 28, fontWeight: "bold", color: NAVY }}>{result.totalFields}</div>
                <div style={{ fontSize: 12, color: "#4A5A8A", fontFamily: "sans-serif", marginTop: 4 }}>Total Fields</div>
              </div>
            </div>

            {result.filledFields.length > 0 && (
              <div style={{ background: "#F0FAF0", border: "1px solid #A8D8A8", borderRadius: 8, padding: "12px 16px", marginBottom: 16, fontFamily: "sans-serif", fontSize: 12, color: "#2E7D32", maxHeight: 80, overflowY: "auto" }}>
                <strong>Filled:</strong> {result.filledFields.join(", ")}
              </div>
            )}

            <button
              onClick={download}
              style={{ background: NAVY, color: "#fff", border: "none", borderRadius: 8, padding: "14px 28px", fontSize: 14, fontFamily: "sans-serif", fontWeight: "bold", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
            >
              ⬇️ Download Completed PDF
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
