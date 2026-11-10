import { useEffect, useState } from "react";
import { api, errText } from "./api";

const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Portal do cliente. O token vem no fragmento (#), é trocado por sessão (POST) e removido da URL. */
export function Portal() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = async () => { try { setData(await api("GET", "/portal/order")); setErr(null); } catch (e) { setErr(errText(e)); } };
  useEffect(() => {
    (async () => {
      const token = location.hash.slice(1);
      if (token) {
        try { await api("POST", "/portal/session", { token }); } catch (e) { setErr(errText(e)); return; }
        history.replaceState(null, "", location.pathname); // remove token da barra/histórico
      }
      await load();
    })();
  }, []);

  if (err && !data) return <main className="portal"><h1>Acompanhe seu veículo</h1><p role="alert">{err}</p><p>Se o link expirou, peça um novo à oficina.</p></main>;
  if (!data) return <main className="portal"><p>Carregando…</p></main>;
  const est = data.estimate;
  const decide = async (decision: "approved" | "rejected", ids: string[]) => {
    try {
      await api("POST", "/portal/approval", { code, versionNo: est.versionNo, decisions: ids.map((itemId) => ({ itemId, decision, justification: notes[itemId] })) });
      setCode(""); setOtpSent(null); await load();
    } catch (e) { setErr(errText(e)); }
  };
  const pending = est?.items.filter((i: any) => i.status === "pending").map((i: any) => i.id) ?? [];
  return (
    <main className="portal" style={{ ["--portal-primary" as any]: data.theme.primaryColor }}>
      <header>
        <h1>{data.shopContact.name}</h1>
        {data.theme.welcomeText && <p>{data.theme.welcomeText}</p>}
        <p>OS {data.orderInfo.number} · {data.orderInfo.vehicle} · <strong>{data.orderInfo.plate}</strong> · Olá, {data.orderInfo.customerFirstName}</p>
        <p>Situação: <strong>{data.status}</strong></p>
      </header>
      {err && <p role="alert">{err}</p>}
      {est && (
        <section aria-labelledby="orc"><h2 id="orc">Orçamento v{est.versionNo} — {brl(est.totalCents)}</h2>
          <ul>{est.items.map((i: any) => (
            <li key={i.id}>{i.description} — {i.qty} × {brl(i.unitPriceCents)} = {brl(i.totalCents)} <em>({i.status})</em>
              {i.status === "pending" && <input aria-label={`Motivo da recusa: ${i.description}`} placeholder="Motivo (se recusar)" value={notes[i.id] ?? ""} onChange={(e) => setNotes({ ...notes, [i.id]: e.target.value })} />}
              {i.status === "pending" && <button disabled={!otpSent || code.length !== 6} onClick={() => decide("rejected", [i.id])}>Recusar</button>}
            </li>))}</ul>
          {pending.length > 0 && (otpSent
            ? <div><label>Código recebido em {otpSent} <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></label>
                <button disabled={code.length !== 6} onClick={() => decide("approved", pending)}>Aprovar tudo pendente</button></div>
            : <button onClick={async () => { try { const r = await api("POST", "/portal/approval/otp"); setOtpSent(r.destination); setErr(null); } catch (e) { setErr(errText(e)); } }}>Enviar código para aprovar</button>)}
        </section>)}
      {data.timeline && <section aria-labelledby="tl"><h2 id="tl">Andamento</h2><ol>{data.timeline.map((t: any, i: number) => <li key={i}>{new Date(t.created_at).toLocaleString("pt-BR")} — {t.title}</li>)}</ol></section>}
      {data.files?.length > 0 && <section><h2>Fotos e documentos</h2>{data.files.map((f: any) => <a key={f.id} href={f.url}><img src={f.url} alt="Foto do veículo" width={120} /></a>)}</section>}
      {data.messages && <section aria-labelledby="ch"><h2 id="ch">Mensagens</h2>
        <ul>{data.messages.map((m: any, i: number) => <li key={i}><strong>{m.sender === "customer" ? "Você" : "Oficina"}:</strong> {m.body}</li>)}</ul>
        <form onSubmit={async (e) => { e.preventDefault(); try { await api("POST", "/portal/messages", { body: msg }); setMsg(""); await load(); } catch (x) { setErr(errText(x)); } }}>
          <input aria-label="Mensagem" value={msg} maxLength={2000} onChange={(e) => setMsg(e.target.value)} /><button disabled={!msg.trim()}>Enviar</button></form></section>}
      <footer><small>{data.privacyNotice}</small></footer>
    </main>
  );
}
