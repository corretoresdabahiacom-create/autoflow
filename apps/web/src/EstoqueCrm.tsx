import { useEffect, useState } from "react";
import { api, errText } from "./api";

const money = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const qty = (m: number) => (m / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 3 });

/** ESTOQUE (UI mínima, KI-058): saldos por unidade, alerta de mínimo e auditoria de consistência. */
export function Estoque({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null); const [ok, setOk] = useState<boolean | null>(null); const [err, setErr] = useState(""); const [low, setLow] = useState(false);
  useEffect(() => { (async () => { try { setRows((await api("GET", `/stock/levels${low ? "?low=1" : ""}`)).levels); setOk((await api("GET", "/stock/audit")).consistent); setErr(""); } catch (e) { setErr(errText(e)); } })(); }, [low]);
  return (
    <main><div className="row"><button className="secondary" onClick={onBack}>← Voltar</button><h1>Estoque</h1></div>
      {err && <p className="error" role="alert">{err}</p>}
      {ok === false && <p className="error" role="alert">Saldo inconsistente com os movimentos — avise o suporte.</p>}
      <label><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Somente abaixo do mínimo</label>
      {rows?.length === 0 && <p className="muted">Nenhum item.</p>}
      <ul className="list">{rows?.map((l) => (
        <li key={`${l.itemId}-${l.unitId}`}><div className="row"><span>{l.sku} · {l.name}</span><span>{qty(l.availableMilli)} {l.uom} disp. ({qty(l.reservedMilli)} reservado) · {money(l.valueCents)}{l.belowMin ? " ⚠ abaixo do mínimo" : ""}</span></div></li>))}</ul>
    </main>
  );
}

/** CRM (UI mínima): métricas, lembretes e campanhas com prévia de consentimento. */
export function Crm({ onBack }: { onBack: () => void }) {
  const [m, setM] = useState<any>(null); const [rem, setRem] = useState<any[]>([]); const [prev, setPrev] = useState<any>(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const load = async () => { try { setM(await api("GET", "/crm/metrics")); setRem((await api("GET", "/crm/reminders")).reminders); setErr(""); } catch (e) { setErr(errText(e)); } };
  useEffect(() => { load(); }, []);
  const preview = async (kind: string) => { try { setPrev({ kind, ...(await api("POST", "/crm/campaigns/preview", { kind })) }); } catch (e) { setErr(errText(e)); } };
  const send = async () => { try { const r = await api("POST", "/crm/campaigns", { kind: prev.kind, name: `Campanha ${prev.kind}` }); setMsg(`${r.queued} mensagens na fila (${r.skippedNoConsent} sem consentimento ignorados).`); setPrev(null); } catch (e) { setErr(errText(e)); } };
  return (
    <main><div className="row"><button className="secondary" onClick={onBack}>← Voltar</button><h1>CRM</h1></div>
      {err && <p className="error" role="alert">{err}</p>}{msg && <p role="status">{msg}</p>}
      {m && <section className="card"><h2>Resultados</h2><p>Leads: {m.leads.total} · convertidos: {m.leads.converted} ({Math.round(m.leads.conversionRate * 100)}%) · receita gerada: {money(m.revenueGeneratedCents)} {m.reconciled ? "" : "⚠ não reconcilia com o financeiro"} · NPS: {m.satisfaction.nps ?? "—"}</p></section>}
      <section className="card"><h2>Campanhas</h2><p className="muted">Só clientes com consentimento de marketing e e-mail recebem.</p>
        <div className="row">{["inactive", "quote_recovery", "reminders"].map((k) => <button key={k} className="secondary" onClick={() => preview(k)}>{{ inactive: "Clientes inativos", quote_recovery: "Orçamentos parados", reminders: "Lembretes" }[k]}</button>)}</div>
        {prev && <p>Elegíveis: {prev.eligible} · sem consentimento: {prev.excludedNoConsent} · sem e-mail: {prev.excludedNoContact} <button disabled={!prev.eligible} onClick={send}>Enviar</button></p>}</section>
      <section><h2>Lembretes pendentes</h2>{rem.length === 0 && <p className="muted">Nenhum.</p>}
        <ul className="list">{rem.map((r) => <li key={r.id}>{r.due_date} · {r.kind} · {r.customer_name} · {r.plate}</li>)}</ul></section>
    </main>
  );
}
