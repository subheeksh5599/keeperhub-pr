import { describe, expect, it } from "vitest";
import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";
import {
  expressionToConditionGroup,
  visualConditionToExpression,
} from "@/lib/workflow/nodes/condition/builder-utils";
import {
  isSafeConditionExpression,
  safeEvaluateCondition,
} from "@/lib/workflow/nodes/condition/safe-eval";
import {
  validateConditionExpression,
  validateConditionExpressionUI,
} from "@/lib/workflow/nodes/condition/validator";

/**
 * Regression coverage for #2407: `matchesRegex` used to compile to
 * `new RegExp(pattern).test(String(value))`, which the validator rejects (`new`
 * is in DANGEROUS_PATTERNS) and the interpreter cannot run (`test` is not an
 * allowed method, and there is no `new`). The operator was therefore reachable
 * from the builder and dead at both ends.
 *
 * These cases assert the operator now evaluates, not merely that it compiles.
 */
const ADDRESS = "0x1111111111111111111111111111111111111111";
const NOT_AN_ADDRESS = "0xnothex";

const ADDRESS_GROUP = {
  logic: "AND",
  rules: [
    {
      leftOperand: "{{@trigger-1:Webhook.safeAddress}}",
      operator: "matchesRegex",
      rightOperand: "^0x[0-9a-fA-F]{40}$",
    },
  ],
} as unknown as ConditionGroup;

/** Substitute the template the way the executor does before evaluating. */
function resolve(expression: string): string {
  return expression.replace(/\{\{@trigger-1:Webhook\.safeAddress\}\}/g, "__v0");
}

describe("matchesRegex compiles to a form the pipeline accepts", () => {
  const expression = visualConditionToExpression(ADDRESS_GROUP);

  it("does not emit the constructs that made it unreachable", () => {
    expect(expression).not.toContain("new RegExp");
    expect(expression).not.toContain(".test(");
    expect(expression).toBe(
      'matchesRegex(String({{@trigger-1:Webhook.safeAddress}}), "^0x[0-9a-fA-F]{40}$")'
    );
  });

  it("passes the runtime validator", () => {
    expect(validateConditionExpression(expression)).toEqual({ valid: true });
  });

  it("passes the UI validator, which reads the same compiled text", () => {
    expect(validateConditionExpressionUI(expression)).toEqual({ valid: true });
  });

  it("passes the interpreter's static allowlist once resolved", () => {
    expect(isSafeConditionExpression(resolve(expression))).toBe(true);
  });
});

describe("matchesRegex evaluates", () => {
  const resolved = resolve(visualConditionToExpression(ADDRESS_GROUP));

  it("matches a value that fits the pattern", () => {
    expect(safeEvaluateCondition(resolved, { __v0: ADDRESS })).toBe(true);
  });

  it("does not match a value that does not fit", () => {
    expect(safeEvaluateCondition(resolved, { __v0: NOT_AN_ADDRESS })).toBe(
      false
    );
  });

  it("a character class is evaluated as a pattern, not as indexing", () => {
    // The [0-9a-fA-F] range is what the bracket scan used to read as
    // `f[0-9a-fA-F]` indexing and reject with "Cannot index".
    expect(safeEvaluateCondition('matchesRegex("abc", "^[a-c]+$")', {})).toBe(
      true
    );
    expect(safeEvaluateCondition('matchesRegex("xyz", "^[a-c]+$")', {})).toBe(
      false
    );
  });

  it("a pattern whose text contains a hyphen is not read as subtraction", () => {
    expect(
      safeEvaluateCondition(
        'matchesRegex("555-1234", "^\\\\d{3}-\\\\d{4}$")',
        {}
      )
    ).toBe(true);
  });
});

describe("matchesRegex did not widen what the pipeline accepts", () => {
  it("still refuses `new`", () => {
    expect(validateConditionExpression('new RegExp("x").test("y")').valid).toBe(
      false
    );
    expect(isSafeConditionExpression('new RegExp("x")')).toBe(false);
    expect(() => safeEvaluateCondition('new RegExp("x")', {})).toThrow();
  });

  it("still refuses `eval`", () => {
    expect(validateConditionExpression('eval("1+1") === 2').valid).toBe(false);
  });

  it("still refuses the `.test` method", () => {
    expect(validateConditionExpression('__v0.test("x")').valid).toBe(false);
    expect(() =>
      safeEvaluateCondition('__v0.test("x")', { __v0: "x" })
    ).toThrow();
  });

  it("still refuses a function name that is not allowlisted", () => {
    expect(() => safeEvaluateCondition('notAllowed("x")', {})).toThrow(
      /not allowed/
    );
  });

  it("still allows a quoted bracket key", () => {
    expect(validateConditionExpression('__v0["key"] === "a"')).toEqual({
      valid: true,
    });
  });

  it("still refuses an array literal", () => {
    expect(validateConditionExpression("__v0 === [1,2,3]").valid).toBe(false);
  });

  it("bounds the pattern length rather than handing the executor a ReDoS", () => {
    const longPattern = "a".repeat(600);
    expect(() =>
      safeEvaluateCondition(`matchesRegex("x", "${longPattern}")`, {})
    ).toThrow(/longer than/);
  });

  it("propagates an invalid pattern as an error rather than a false match", () => {
    expect(() => safeEvaluateCondition('matchesRegex("x", "[")', {})).toThrow();
  });
});

describe("matchesRegex round-trips through the visual builder", () => {
  it("parses the form the builder now emits", () => {
    const parsed = expressionToConditionGroup(
      'matchesRegex(String({{@trigger-1:Webhook.safeAddress}}), "^0x[0-9a-fA-F]{40}$")'
    );
    const rule = parsed?.rules[0] as
      | { operator?: string; leftOperand?: string; rightOperand?: string }
      | undefined;
    expect(rule?.operator).toBe("matchesRegex");
    expect(rule?.rightOperand).toBe("^0x[0-9a-fA-F]{40}$");
  });

  it("still parses the form saved workflows hold", () => {
    // Conditions stored before this change contain `new RegExp(...).test(...)`,
    // so the parser has to keep reading it or those nodes stop reopening.
    const parsed = expressionToConditionGroup(
      'new RegExp("^[a-z]+@").test(String({{@trigger-1:Webhook.safeAddress}}))'
    );
    const rule = parsed?.rules[0] as { operator?: string } | undefined;
    expect(rule?.operator).toBe("matchesRegex");
  });
});
