import { describe, expect, it } from "vitest";
import { csrfMatches, familyLoginEmail, invitationAccess, nextDemoSlug, passwordProblems, productAccess, publishErrors, slugReserved } from "./security.js";

describe("invitation access rules", () => {
  it("refuses to publish an incomplete invitation", () => {
    expect(
      publishErrors({ title: "", slug: "Bad Slug", brideName: "", groomName: "A", weddingAt: null, venueName: "" }).length,
    ).toBeGreaterThan(0);
  });

  it("accepts a complete invitation", () => {
    expect(
      publishErrors({
        title: "Meera and Arjun",
        slug: "meera-and-arjun",
        brideName: "Meera",
        groomName: "Arjun",
        weddingAt: new Date("2027-02-12T00:00:00+05:30"),
        venueName: "The Amber Pavilion",
      }),
    ).toEqual([]);
  });

  it("lets a super admin change every invitation and product", () => {
    expect(invitationAccess("super_admin", [], "create")).toBe("allow");
    expect(invitationAccess("super_admin", [], "publish", "card-1")).toBe("allow");
    expect(productAccess("super_admin", "write")).toBe("allow");
  });

  it("limits a customer to the invitations they were given", () => {
    expect(invitationAccess("customer", [], "read", "card-1")).toBe("deny");
    expect(invitationAccess("customer", ["card-1"], "update", "card-1")).toBe("allow");
    expect(invitationAccess("customer", ["card-1"], "update", "card-2")).toBe("deny");
    expect(invitationAccess("customer", ["card-1"], "create")).toBe("deny");
    expect(invitationAccess("customer", ["card-1"], "delete", "card-1")).toBe("deny");
    expect(invitationAccess("customer", ["card-1"], "publish", "card-1")).toBe("deny");
    expect(productAccess("customer", "write")).toBe("deny");
    expect(productAccess("customer", "read")).toBe("allow");
  });

  it("binds the csrf header to the session token", () => {
    expect(csrfMatches("abc", "abc")).toBe(true);
    expect(csrfMatches("abc", "abd")).toBe(false);
    expect(csrfMatches("abc", undefined)).toBe(false);
  });
});

describe("family login details", () => {
  it("always uses the studio email domain", () => {
    expect(familyLoginEmail("rahul")).toBe("rahul@creationsbysneha.in");
    expect(familyLoginEmail("Rahul@Gmail.com")).toBe("rahul@creationsbysneha.in");
    expect(familyLoginEmail("  meera.family  ")).toBe("meera.family@creationsbysneha.in");
  });

  it("accepts an 8 character password with a letter and a number", () => {
    expect(passwordProblems("Welcome1")).toEqual([]);
    expect(passwordProblems("short")).toContain("Use at least 8 characters.");
  });
});

describe("demo public links", () => {
  it("starts extra looks at demo2", () => {
    expect(nextDemoSlug([])).toBe("demo2");
    expect(nextDemoSlug(["demo2"])).toBe("demo3");
    expect(nextDemoSlug(["demo2", "demo3", "saanvi-and-kabir"])).toBe("demo4");
  });

  it("lets a demo use /demo, but not the other reserved links", () => {
    expect(slugReserved("demo")).toBe(true);
    expect(slugReserved("demo", true)).toBe(false);
    expect(slugReserved("admin", true)).toBe(true);
  });
});
