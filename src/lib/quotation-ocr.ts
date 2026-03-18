import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface QuotationData {
  totalPrice: number | null;
  grandTotal: number | null;
  paymentTerms: string | null;
  subtotal: number | null;
}

/**
 * Download a PDF from a URL (ClickUp attachment), convert page 2 to image,
 * OCR it, and extract Total Price, Grand Total, and Payment Terms.
 *
 * NOWN quotations have the totals on page 2 in a consistent format:
 *   Total Price    EUR27,290.57
 *   Grand Total    EUR27,290.57
 *   Payment Terms: 50% manufacture, 50% pre-ship
 */
export async function extractFromQuotationPDF(
  pdfUrl: string,
  authToken: string
): Promise<QuotationData> {
  const tmpBase = join(tmpdir(), `quotation-${Date.now()}`);
  const pdfPath = `${tmpBase}.pdf`;
  const imgPrefix = `${tmpBase}-img`;

  try {
    // Download PDF
    const response = await fetch(pdfUrl, {
      headers: { Authorization: authToken },
    });
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(pdfPath, buffer);

    // Convert page 1 and 2 to images (totals are usually on page 2, but check both)
    // Run from tmpdir to avoid path issues with tesseract
    const cwd = tmpdir();
    execSync(
      `pdftoppm -png -r 200 -f 1 -l 2 "${pdfPath}" "${imgPrefix}"`,
      { cwd, timeout: 30000 }
    );

    // OCR pages and concatenate text
    let fullText = "";
    for (const suffix of ["-1.png", "-2.png", "-01.png", "-02.png"]) {
      const imgPath = `${imgPrefix}${suffix}`;
      if (existsSync(imgPath)) {
        try {
          const ocrText = execSync(`tesseract "${imgPath}" stdout`, {
            cwd,
            timeout: 30000,
            encoding: "utf-8",
          });
          fullText += ocrText + "\n";
        } catch {
          // Skip if OCR fails for a page
        }
      }
    }

    return parseQuotationText(fullText);
  } finally {
    // Cleanup temp files
    for (const ext of [".pdf", "-img-1.png", "-img-2.png", "-img-01.png", "-img-02.png"]) {
      const path = `${tmpBase}${ext}`;
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Parse OCR text from a NOWN quotation to extract key financial data.
 */
function parseQuotationText(text: string): QuotationData {
  const result: QuotationData = {
    totalPrice: null,
    grandTotal: null,
    paymentTerms: null,
    subtotal: null,
  };

  // Extract amounts: look for "Total Price EUR27,290.57" or "Grand Total EUR27,290.57"
  // Handle various OCR artifacts and EUR format variations
  const totalPriceMatch = text.match(
    /Total\s*Price\s*(?:EUR|€)\s*([\d.,]+)/i
  );
  if (totalPriceMatch) {
    result.totalPrice = parseEurAmount(totalPriceMatch[1]);
  }

  const grandTotalMatch = text.match(
    /Grand\s*Total\s*(?:EUR|€)\s*([\d.,]+)/i
  );
  if (grandTotalMatch) {
    result.grandTotal = parseEurAmount(grandTotalMatch[1]);
  }

  const subtotalMatch = text.match(
    /Subtotal\s*(?:EUR|€)\s*([\d.,]+)/i
  );
  if (subtotalMatch) {
    result.subtotal = parseEurAmount(subtotalMatch[1]);
  }

  // Extract payment terms: "Payment Terms: 50% manufacture, 50% pre-ship"
  const termsMatch = text.match(
    /Payment\s*Terms:?\s*(.+?)(?:\n|Subtotal|$)/i
  );
  if (termsMatch) {
    result.paymentTerms = termsMatch[1].trim();
  }

  return result;
}

/**
 * Parse EUR amount string, handling both formats:
 * - Standard: 27,290.57 or 27290.57
 * - European: 27.290,57
 */
function parseEurAmount(raw: string): number {
  let s = raw.trim();
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  if (lastComma > lastDot) {
    // European: 27.290,57
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Standard: 27,290.57
    s = s.replace(/,/g, "");
  }

  const val = parseFloat(s);
  return isNaN(val) ? 0 : val;
}
