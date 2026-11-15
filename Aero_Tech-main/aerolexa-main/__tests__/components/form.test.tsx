/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "@/components/ui/button";
import { Input, Textarea, Select, Checkbox, Field } from "@/components/ui/form";

describe("form primitives", () => {
  it("links label to input via htmlFor", () => {
    render(<Input id="email" label="Email" />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("id", "email");
  });

  it("surfaces validation errors with role=alert and marks the field invalid", () => {
    render(<Input id="pw" label="Password" error="Too short." required />);
    expect(screen.getByRole("alert")).toHaveTextContent("Too short.");
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute("aria-invalid", "true");
  });

  it("renders helper text when present", () => {
    render(<Textarea id="bio" label="Bio" helper="2-3 sentences." />);
    expect(screen.getByText("2-3 sentences.")).toBeInTheDocument();
  });

  it("renders Select options with placeholder", () => {
    render(
      <Select
        id="role"
        label="Role"
        placeholder="Choose…"
        options={[
          { value: "a", label: "Analyst" },
          { value: "b", label: "Scientist" },
        ]}
      />,
    );
    const select = screen.getByLabelText("Role");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Choose…" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Analyst" })).toBeInTheDocument();
  });

  it("Checkbox toggles on click", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Checkbox label="Notify me" checked={false} onChange={onChange} />);
    await user.click(screen.getByText("Notify me"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("Button renders children and announces busy state", () => {
    render(<Button loading>Save</Button>);
    const btn = screen.getByRole("button", { name: /save/i });
    expect(btn).toBeDisabled();
  });

  it("Field shows required marker", () => {
    render(
      <Field label="Name" required htmlFor="name">
        <input id="name" />
      </Field>,
    );
    expect(screen.getByText("*")).toBeInTheDocument();
  });
});
