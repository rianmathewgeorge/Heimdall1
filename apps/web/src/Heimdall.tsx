import { useCallback, useEffect, useState } from "react";
import { IconAlert, IconArrow, IconFile, IconGlobe, IconShieldOff, IconTerminal } from "./HeimdallIcons";
import { heimdallApi, type CapabilityVerdict, type Permit, type Tier, type HeimdallStatus } from "./heimdallClient";

const THRESHOLD: Record<Tier, number> = { T0: 0, T1: 3, T2: 5, T3: 10, T4: 15 };
const Ico = ({ children }: { children: React.ReactNode }) => <span className="wr-ico">{children}</span>;

function Verdict({ verdict }: { verdict: CapabilityVerdict }) {
  return (
    <div className="wr-verdict">
      <div className="wr-verdict-head">
        <span className={"tier tier-" + verdict.tier.toLowerCase()}>{verdict.tier}</span>
        <strong>
          {verdict.summary}
          <span className="wr-target">{verdict.target}</span>
        </strong>
        <span className="wr-score wr-num">
          {verdict.score === null ? "hard rule" : verdict.score + " pts"}
        </span>
      </div>

      {verdict.hardRule ? (
        <p className="wr-hard"><Ico><IconShieldOff /></Ico>{verdict.hardRule}</p>
      ) : (
        <ul className="wr-receipt">
          {verdict.receipt.map((line, i) => (
            <li key={i} className={line.pts < 0 ? "is-credit" : ""}>
              <span className="wr-pts">{line.pts > 0 ? "+" + line.pts : line.pts}</span>
              <span>{line.why}</span>
            </li>
          ))}
          <li className="is-total">
            <span className="wr-pts">{verdict.score}</span>
            <span>total — {verdict.tier} starts at {THRESHOLD[verdict.tier]}</span>
          </li>
        </ul>
      )}

      {verdict.resolvedBy && (
        <p className="wr-note"><Ico><IconArrow /></Ico>Settled in code by {verdict.resolvedBy}</p>
      )}
      {verdict.narrowedTo && (
        <p className="wr-note">
          <Ico><IconArrow /></Ico>
          Counter-offer: granting {verdict.narrowedTo.length} specific path
          {verdict.narrowedTo.length === 1 ? "" : "s"} instead of the pattern
        </p>
      )}
    </div>
  );
}

export function PermissionCard({
  permit, onDecide,
}: { permit: Permit; onDecide(decision: "approved" | "denied"): void }) {
  const [busy, setBusy] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approved" | "denied") => {
    setBusy(decision); setError(null);
    try { await heimdallApi.decide(permit.runId, decision); onDecide(decision); }
    catch { setError("Could not reach the control plane. The run is still held — try again."); }
    finally { setBusy(null); }
  };

  const grants: Array<[React.ReactNode, string, string[]]> = [
    [<IconFile key="f" />, "Modify", permit.grantedWrites],
    [<IconTerminal key="t" />, "Run", permit.grantedCommands],
    [<IconGlobe key="g" />, "Reach", permit.grantedHosts],
  ];

  return (
    <div className="wr-backdrop" onKeyDown={(e) => { if (e.key === "Escape") void decide("denied"); }}>
      <div className="wr-card" role="dialog" aria-modal="true" aria-label="Heimdall permit">
        <div className="wr-card-head">
          <h2>{permit.summary}</h2>
          <span className={"tier tier-" + permit.runTier.toLowerCase()}>{permit.runTier}</span>
        </div>

        <p className="wr-lede">
          This run declared what it needs before it was allowed to start. Approving grants{" "}
          <strong>only</strong> what is listed here — the runtime blocks everything else, whatever
          the agent is later told to do.
        </p>

        {grants.some(([, , items]) => items.length > 0) && (
          <div className="wr-grants">
            {grants.map(([icon, verb, items]) =>
              items.length === 0 ? null : (
                <div className="wr-grant" key={verb}>
                  <span className="wr-ico">{icon}</span>
                  <span>{verb}</span>
                  <code>{items.join("  ·  ")}</code>
                </div>
              ))}
          </div>
        )}

        <div className="wr-verdicts">
          {permit.verdicts.map((v) => <Verdict key={v.fingerprint + v.target} verdict={v} />)}
        </div>

        {error && <p className="wr-hard" style={{ marginLeft: 0 }}><Ico><IconAlert /></Ico>{error}</p>}

        <div className="wr-card-foot">
          <span className="wr-meta">
            term sheet v{permit.termSheetVersion} · {permit.permitId} · {permit.requestHash.slice(0, 12)}
          </span>
          <div className="wr-actions">
            <button className="button button-ghost" disabled={busy !== null}
              onClick={() => void decide("denied")}>
              {busy === "denied" ? "Refusing…" : "Refuse"}
            </button>
            <button className="button button-primary" disabled={busy !== null}
              onClick={() => void decide("approved")}>
              {busy === "approved" ? "Granting…" : "Grant these"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function useHeimdall(agentId: string | null, enabled: boolean) {
  const [status, setStatus] = useState<HeimdallStatus | null>(null);
  const [pending, setPending] = useState<Permit | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [s, p] = await Promise.all([heimdallApi.status(), heimdallApi.pending()]);
      setStatus(s);
      setPending(p.pending.find((permit) => permit.agentId === agentId) ?? p.pending[0] ?? null);
    } catch { /* transient — keep the last good state */ }
  }, [agentId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, enabled]);

  return { status, pending, refresh, setPending };
}
