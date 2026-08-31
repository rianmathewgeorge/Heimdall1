import { useEffect, useState } from "react";
import { heimdallApi, type CapabilityVerdict, type HeimdallRun, type HeimdallStatus } from "../../heimdallClient";
import type { AgentRun } from "../../types";
import { IconAlert, IconFile, IconGlobe, IconShield, IconShieldOff, IconTerminal } from "../../HeimdallIcons";

function opIcon(op: string) {
  if (op.startsWith("NET")) return <IconGlobe />;
  if (op === "EXEC" || op === "PROC_SPAWN") return <IconTerminal />;
  return <IconFile />;
}

function tierMeaning(tier: string): string {
  switch (tier) {
    case "T0": return "Allowed automatically — no risk indicators";
    case "T1": return "Allowed automatically, with notice";
    case "T2": return "Resolved by deterministic policy code";
    case "T3": return "Required a human operator's approval";
    case "T4": return "Denied — refused before execution";
    default: return tier;
  }
}

function VerdictRow({ verdict }: { verdict: CapabilityVerdict }) {
  const [expanded, setExpanded] = useState(false);
  const granted = verdict.tier === "T0" || verdict.tier === "T1";
  return (
    <div className={"perm-row perm-" + (granted ? "granted" : verdict.tier === "T4" ? "denied" : "review")}>
      <div className="perm-row-head">
        <span className="perm-ico">{opIcon(verdict.op)}</span>
        <span className={"tier tier-" + verdict.tier.toLowerCase()}>{verdict.tier}</span>
        <strong>{verdict.summary}</strong>
        <button className="perm-toggle" onClick={() => setExpanded((v) => !v)}>{expanded ? "Hide detail" : "Show detail"}</button>
      </div>
      <p className="perm-explain">{tierMeaning(verdict.tier)}{verdict.hardRule ? " — " + verdict.hardRule : ""}</p>
      {expanded && (
        <div className="perm-detail">
          <code className="mono perm-target">{verdict.target}</code>
          {verdict.hardRule ? (
            <p className="wr-hard"><IconShieldOff /> {verdict.hardRule}</p>
          ) : (
            <ul className="wr-receipt">
              {verdict.receipt.map((line, i) => (
                <li key={i} className={line.pts < 0 ? "is-credit" : ""}>
                  <span className="wr-pts">{line.pts > 0 ? "+" + line.pts : line.pts}</span>
                  <span>{line.why}</span>
                </li>
              ))}
            </ul>
          )}
          {verdict.resolvedBy && <p className="wr-note">Settled in code by {verdict.resolvedBy}</p>}
          {verdict.narrowedTo && (
            <p className="wr-note">Counter-offer: granted {verdict.narrowedTo.length} specific path(s) instead of the pattern.</p>
          )}
        </div>
      )}
    </div>
  );
}

export interface PermissionsTabProps {
  run: AgentRun | null;
  heimdallStatus: HeimdallStatus | null;
}

export function PermissionsTab({ run, heimdallStatus }: PermissionsTabProps) {
  const [heimdallRun, setHeimdallRun] = useState<HeimdallRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    setHeimdallRun(null);
    setError(null);
    if (!run?.heimdallRunId) return;
    let cancelled = false;
    heimdallApi
      .run(run.heimdallRunId)
      .then(({ run: fetched }) => { if (!cancelled) setHeimdallRun(fetched); })
      .catch(() => { if (!cancelled) setError("Could not load permission detail for this run."); });
    return () => { cancelled = true; };
  }, [run?.heimdallRunId]);

  const statusBanner = heimdallStatus && (
    <div className={"wr-status-line " + (heimdallStatus.enabled ? "" : "is-off")}>
      <IconShield />
      {heimdallStatus.enabled ? "Heimdall is enforcing" : "Heimdall is disabled (HEIMDALL=off)"}
      {heimdallStatus.enabled && (
        <span className={heimdallStatus.ledger.valid ? "perm-ok-inline" : "wr-hard"}>
          {heimdallStatus.ledger.valid ? "· ledger intact" : "· ledger broken at " + heimdallStatus.ledger.brokenAt}
          {" (" + heimdallStatus.ledger.events + " events)"}
        </span>
      )}
    </div>
  );

  if (!run) {
    return <div className="tab-panel">{statusBanner}<div className="tab-panel-empty"><p className="wr-empty">No run selected yet.</p></div></div>;
  }
  if (!run.heimdallRunId) {
    return (
      <div className="tab-panel">
        {statusBanner}
        <div className="tab-panel-empty">
          <p className="wr-empty">
            Heimdall did not evaluate this run yet — it will appear here once reconnaissance starts, or Heimdall is
            disabled for this deployment (HEIMDALL=off).
          </p>
        </div>
      </div>
    );
  }
  if (error) return <div className="tab-panel">{statusBanner}<div className="tab-panel-empty"><p className="wr-empty">{error}</p></div></div>;
  if (!heimdallRun) return <div className="tab-panel">{statusBanner}<div className="wr-skeleton" /></div>;

  const permit = heimdallRun.permit;
  const integrityOk = permit ? permit.approvedHash === null || permit.approvedHash === permit.requestHash : true;
  const undeclared = heimdallRun.divergences.filter((d) => d.kind === "undeclared");

  return (
    <div className="tab-panel permissions-tab">
      {statusBanner}
      <section className="inspector-block">
        <span className="inspector-block-title">Recon manifest</span>
        {heimdallRun.manifest ? (
          <>
            <p className="perm-summary">{heimdallRun.manifest.summary}</p>
            <p className="perm-note">{heimdallRun.manifest.capabilities.length} capability(ies) declared before execution.</p>
          </>
        ) : (
          <p className="wr-hard"><IconShieldOff /> {heimdallRun.manifestError ?? "Recon did not produce a manifest."}</p>
        )}
      </section>

      {permit && (
        <section className="inspector-block">
          <span className="inspector-block-title">Permit integrity</span>
          <dl className="fact-grid">
            <div><dt>Permit</dt><dd className="mono truncate">{permit.permitId}</dd></div>
            <div><dt>Tier</dt><dd><span className={"tier tier-" + permit.runTier.toLowerCase()}>{permit.runTier}</span></dd></div>
            <div><dt>Request hash</dt><dd className="mono truncate">{permit.requestHash.slice(0, 16)}</dd></div>
            <div><dt>Approved hash</dt><dd className="mono truncate">{permit.approvedHash?.slice(0, 16) ?? "—"}</dd></div>
          </dl>
          <p className={integrityOk ? "perm-ok" : "wr-hard"}>
            {integrityOk ? <IconShield /> : <IconAlert />}
            {integrityOk
              ? " Granted capability set matches what was decided — nothing drifted between approval and execution."
              : " The granted set no longer matches what was approved. Execution would fail closed."}
          </p>
        </section>
      )}

      {permit && (
        <section className="inspector-block">
          <span className="inspector-block-title">Capabilities — granted, denied, and why</span>
          <div className="perm-rows">
            {permit.verdicts.map((v) => <VerdictRow key={v.fingerprint + v.target} verdict={v} />)}
          </div>
        </section>
      )}

      {heimdallRun.denials.length > 0 && (
        <section className="inspector-block">
          <span className="inspector-block-title">Blocked at runtime</span>
          {heimdallRun.denials.map((d, i) => (
            <div className="wr-denial" key={i}>
              <div className="wr-denial-head">
                <span className="wr-rule">{d.rule}</span>
                <span className="perm-ico">{opIcon(d.op)}</span>
                <strong>{d.target}</strong>
              </div>
              <p className="wr-detail">{d.detail}</p>
            </div>
          ))}
        </section>
      )}

      <section className="inspector-block">
        <span className="inspector-block-title">Declared vs. observed</span>
        <p className="perm-note">
          {heimdallRun.actual.length} action(s) observed during execution
          {undeclared.length > 0 ? `, ${undeclared.length} outside the manifest` : ", all within the manifest"}.
        </p>
        {undeclared.length > 0 && (
          <ul className="wr-receipt">
            {undeclared.map((d, i) => (
              <li key={i}><span className="wr-pts">!</span><span>{d.op} {d.target}</span></li>
            ))}
          </ul>
        )}
      </section>

      <details className="wr-details" open={showRaw} onToggle={(e) => setShowRaw(e.currentTarget.open)}>
        <summary>Raw permit and manifest JSON</summary>
        <pre className="raw-json">{JSON.stringify(heimdallRun, null, 2)}</pre>
      </details>
    </div>
  );
}
