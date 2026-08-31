/**
 * Model answers are markdown with LaTeX. The Playground printed them raw, so a
 * correct answer about covariance arrived as literal `###`, `**bold**` and
 * `\[\operatorname{Cov}(X,Y)=\frac{1}{n}\sum...\]` — the reader was shown the
 * source instead of the answer.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { MessageBody } from "./MessageBody.js";

/** Trimmed from a real run. */
const ANSWER = [
  "Covariance tells us how two variables change together.",
  "",
  "### Formula",
  "",
  "- **Population covariance**",
  "  \\[",
  "  \\operatorname{Cov}(X,Y)=\\frac{1}{n}\\sum_{i=1}^{n}(x_i-\\mu_X)(y_i-\\mu_Y)",
  "  \\]",
  "",
  "Inline: \\(\\rho_{X,Y}\\) is the correlation.",
  "",
  "| x | y |",
  "|---|---|",
  "| 2 | 5 |",
  "",
  "Use `npm test` to check.",
].join("\n");

describe("MessageBody", () => {
  test("markdown becomes structure, not literal punctuation", () => {
    const { container } = render(<MessageBody content={ANSWER} />);
    expect(container.querySelector("h3")?.textContent).toBe("Formula");
    expect(container.querySelector("strong")?.textContent).toBe("Population covariance");
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("npm test");
    // the reader must never see the source
    expect(container.textContent).not.toContain("### Formula");
    expect(container.textContent).not.toContain("**Population");
  });

  /**
   * KaTeX keeps the original TeX in a hidden <annotation> for accessibility and
   * copy-paste, so `textContent` legitimately still contains `\operatorname`.
   * What matters is what a reader SEES, so the MathML branch is removed first.
   */
  function visibleText(container: HTMLElement): string {
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".katex-mathml").forEach((n) => { n.remove(); });
    return clone.textContent ?? "";
  }

  test("LaTeX is typeset, block and inline", () => {
    const { container } = render(<MessageBody content={ANSWER} />);
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(1);   // block AND inline
    expect(container.querySelector(".katex-display")).not.toBeNull();          // \[…\] is a display block
    // and the reader is never shown the source
    const seen = visibleText(container);
    expect(seen).not.toContain("\\operatorname");
    expect(seen).not.toContain("\\frac");
    expect(seen).not.toContain("\\[");
    expect(seen).not.toContain("\\(");
  });

  test("model output cannot inject markup into the operator's console", () => {
    const { container } = render(
      <MessageBody content={'<img src=x onerror="alert(1)"> and <script>alert(2)</script>'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // it is shown as text instead
    expect(container.textContent).toContain("alert(1)");
  });

  test("a link opens safely in a new tab", () => {
    const { container } = render(<MessageBody content="[docs](https://example.com)" />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noreferrer");
  });

  test("malformed LaTeX degrades instead of throwing", () => {
    expect(() => render(<MessageBody content={"$$ \\frac{1}{ $$"} />)).not.toThrow();
  });

  test("plain text still renders as plain text", () => {
    render(<MessageBody content="Just a sentence." />);
    expect(screen.getByText("Just a sentence.")).toBeTruthy();
  });
});
