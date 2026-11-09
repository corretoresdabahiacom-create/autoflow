import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface EntryTermData {
  tenantName: string;
  osNumber: number;
  customerName: string;
  plate: string;
  vehicle: string;
  km: number | null;
  fuelLevel: string | null;
  notes: string | null;
  marks: { area: string; kind: string; note: string | null }[];
  confirmedByName: string;
  confirmedAt: Date;
}

const FUEL: Record<string, string> = { empty: "Reserva", quarter: "1/4", half: "1/2", three_quarters: "3/4", full: "Cheio" };
const KIND: Record<string, string> = { scratch: "Arranhão", dent: "Amassado", crack: "Trinca", broken: "Quebrado", missing: "Faltando", other: "Outro" };

// Fonte padrão do PDF (WinAnsi) não suporta todos os caracteres: normaliza o que não couber.
const safe = (s: string) => s.replace(/[^\x20-\x7E -ÿ]/g, "?");

export async function buildEntryTermPdf(d: EntryTermData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 800;
  const line = (text: string, o: { b?: boolean; size?: number } = {}) => {
    if (y < 60) { page = pdf.addPage([595, 842]); y = 800; }
    page.drawText(safe(text), { x: 50, y, size: o.size ?? 11, font: o.b ? bold : font, color: rgb(0, 0, 0), maxWidth: 495 });
    y -= (o.size ?? 11) + 7;
  };
  line("TERMO DE ENTRADA DE VEICULO", { b: true, size: 16 });
  line(d.tenantName);
  y -= 6;
  line(`OS n. ${d.osNumber}`, { b: true });
  line(`Cliente: ${d.customerName}`);
  line(`Veiculo: ${d.vehicle}  |  Placa: ${d.plate}`);
  line(`Km: ${d.km ?? "nao informado"}  |  Combustivel: ${d.fuelLevel ? (FUEL[d.fuelLevel] ?? d.fuelLevel) : "nao informado"}`);
  if (d.notes) line(`Observacoes: ${d.notes}`);
  y -= 6;
  line("Avarias registradas na entrada:", { b: true });
  if (d.marks.length === 0) line("Nenhuma avaria registrada.");
  for (const m of d.marks) line(`- ${m.area}: ${KIND[m.kind] ?? m.kind}${m.note ? ` (${m.note})` : ""}`);
  y -= 10;
  line("Declaro que o estado do veiculo na entrada confere com o registrado acima.");
  line(`Confirmado por: ${d.confirmedByName}`);
  line(`Data/hora (UTC): ${d.confirmedAt.toISOString()}`);
  line("Este termo registra a vistoria; nao substitui avaliacao juridica.", { size: 9 });
  return pdf.save();
}
