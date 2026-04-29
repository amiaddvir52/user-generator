import React from "react";

type ButtonTone = "primary" | "secondary" | "danger";
type ButtonSize = "md" | "sm";

export const Button = ({
  children,
  className,
  disabled,
  onClick,
  tone = "primary",
  size = "md",
  type = "button"
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  tone?: ButtonTone;
  size?: ButtonSize;
  type?: "button" | "submit";
}) => (
  <button
    className={`ui-button ${tone} ${size}${className ? ` ${className}` : ""}`}
    disabled={disabled}
    onClick={onClick}
    type={type}
  >
    {children}
  </button>
);

export const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="ui-label">{children}</label>
);

export const Field = ({ children }: { children: React.ReactNode }) => (
  <div className="ui-field">{children}</div>
);

export const Banner = ({
  children,
  tone = "info"
}: {
  children: React.ReactNode;
  tone?: "info" | "warning" | "error";
}) => <section className={`ui-banner ${tone}`}>{children}</section>;

export const StatusBadge = ({
  children,
  tone = "neutral"
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) => <span className={`ui-badge ${tone}`}>{children}</span>;

export const Card = ({
  children,
  className
}: {
  children: React.ReactNode;
  className?: string;
}) => <section className={`ui-card${className ? ` ${className}` : ""}`}>{children}</section>;

export const SectionHeading = ({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) => (
  <header className="section-heading">
    <div>
      {eyebrow && <p className="section-eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      {description && <p className="section-description">{description}</p>}
    </div>
    {action && <div className="section-action">{action}</div>}
  </header>
);

export const InlineCode = ({ children }: { children: React.ReactNode }) => (
  <code className="inline-code">{children}</code>
);
