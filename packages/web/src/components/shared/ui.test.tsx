import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./ui";

describe("Card", () => {
  it("without a title id: a <div>, its title an <h3> with no id — the markup every card had", () => {
    const { container } = render(
      <Card title="Recent activity" action={<a href="/runs">View all</a>} className="mb-6">
        <p>body</p>
      </Card>,
    );

    expect(container.innerHTML).toBe(
      '<div class="rounded-lg border border-gray-200 dark:border-gray-900 bg-white dark:bg-gray-950/40 mb-6">' +
        '<div class="flex items-center justify-between px-4 h-10 border-b border-gray-100 dark:border-gray-900">' +
        '<h3 class="text-[12.5px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">Recent activity</h3>' +
        '<a href="/runs">View all</a></div>' +
        '<div class="p-4"><p>body</p></div></div>',
    );
  });

  it("with a title id: a <section> named by its title, which carries the id", () => {
    const { container } = render(
      <Card title="Usage" titleId="usage-title" pad={false}>
        <p>body</p>
      </Card>,
    );

    const region = screen.getByRole("region", { name: "Usage" });
    expect(region.tagName).toBe("SECTION");
    expect(region).toBe(container.firstElementChild);
    expect(region).toHaveAttribute("aria-labelledby", "usage-title");
    expect(screen.getByRole("heading", { level: 3, name: "Usage" })).toHaveAttribute(
      "id",
      "usage-title",
    );
  });

  it.each([
    ["no title, no action", {}],
    ["an action, no title", { action: <a href="/runs">View all</a> }],
    ["an empty title", { title: "" }],
  ])("with a title id but %s: a <div> labelled by nothing — no title to carry the id", (_case, props) => {
    const { container } = render(
      <Card titleId="usage-title" pad={false} {...props}>
        <p>body</p>
      </Card>,
    );

    const root = container.firstElementChild;
    expect(root?.tagName).toBe("DIV");
    expect(root).not.toHaveAttribute("aria-labelledby");
    expect(container.querySelector("#usage-title")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });
});
