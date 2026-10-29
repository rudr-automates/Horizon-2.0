import type { ReactNode } from "react";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Logo } from "@/components/site-header";
import { Input } from "@/components/ui/input";

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5 py-12">
      <Logo />
      <div className="paper-card mt-8 w-full max-w-md p-8">
        <h1 className="text-3xl">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function PasswordInput(props: React.ComponentProps<typeof Input>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={show ? "text" : "password"} className="pr-10" />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground"
        aria-label={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
