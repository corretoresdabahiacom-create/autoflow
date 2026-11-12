import { useEffect, useState } from "react";
import { api, errText } from "./api";

const money = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** INTEGRAÇÕES E ASSINATURA (UI mínima, KI-072): status das conexões (segredo nunca exibido) e da assinatura. */
export function Integracoes({ onBack }: { onBack: () => void }) {
  const [conns, setConns] = useState<any[] | null>(null); const [bill, setBill] = useState<any>(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const load = async () => {
    try { setConns((await api("GET", "/integrations")).connections); } catch (e) { setErr(errText(e)); }
    try { setBill(await api("GET", "/billing")); } catch { setBill(null); }
  };
  useEffect(() => { load(); }, []);
  const disconnect = async (kind: string) => { if (!confirm("Desconectar? O segredo será apagado e envios pendentes cancelados.")) return; try { await api("DELETE", `/integrations/${kind}`); setMsg("Desconectado."); load(); } catch (e) { setErr(errText(e)); } };
  const cancel = async () => { try { await api("POST", "/billing/cancel"); setMsg("Cancelamento agendado para o fim do período."); load(); } catch (e) { setErr(errText(e)); } };
  return (
    <main><div className="row"><button className="secondary" onClick={onBack}>← Voltar</button><h1>Integrações e assinatura</h1></div>
      {err && <p className="error" role="alert">{err}</p>}{msg && <p role="status">{msg}</p>}
      <section className="card"><h2>Conexões</h2>
        {conns?.length === 0 && <p className="muted">Nenhuma conexão. WhatsApp e pagamentos online exigem credenciais (conexão via API; ver docs/INTEGRATIONS.md).</p>}
        <ul className="list">{conns?.map((c) => <li key={`${c.kind}-${c.connected_at}`}><div className="row"><span>{c.kind} · {c.provider} · {c.status === "connected" ? `conectado (segredo ${c.secret_hint}, v${c.secret_version})` : "desconectado"}</span>{c.status === "connected" && <button className="secondary" onClick={() => disconnect(c.kind)}>Desconectar</button>}</div></li>)}</ul></section>
      {bill && <section className="card"><h2>Assinatura</h2>
        <p>Plano {bill.subscription.plan_name} · situação: {bill.subscription.status}{bill.subscription.cancel_at_period_end ? " · cancelamento agendado" : ""}</p>
        {bill.invoices.map((i: any) => <p key={i.id} className="muted">{i.kind} · {money(i.amount_cents)} · {i.status}</p>)}
        {!bill.subscription.cancel_at_period_end && <button className="secondary" onClick={cancel}>Cancelar ao fim do período</button>}</section>}
    </main>
  );
}
