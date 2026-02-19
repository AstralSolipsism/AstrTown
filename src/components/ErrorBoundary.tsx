import { ExitIcon } from "@radix-ui/react-icons";
import React, { ReactNode, ErrorInfo } from "react";
import { Button } from "@ui/Button";
import { Sheet } from "@ui/Sheet";
import { useTranslation } from "@common/lib/i18n";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error?: Error;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(e: Error): ErrorBoundaryState {
    return { error: e };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    const { error } = this.state;
    const { children } = this.props;
    if (error) {
      return <ErrorBoundaryFallback error={error} />;
    }

    return children;
  }
}

function ErrorBoundaryFallback({ error }: { error: Error }) {
  const { t } = useTranslation();

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-4">
      <h3>{t("selfHosted.errors.somethingWentWrong")}</h3>
      <div className="flex flex-col items-center gap-2">
        {error.message.includes("not permitted") && (
          <p role="alert" className="text-sm">
            {t("selfHosted.errors.invalidAdminKey")}
          </p>
        )}
        <Button
          className="w-fit"
          icon={<ExitIcon />}
          size="xs"
          onClick={() => {
            window.sessionStorage.setItem("adminKey", "");
            window.location.reload();
          }}
          variant="neutral"
        >
          {t("header.logOut")}
        </Button>
      </div>
      <Sheet className="max-h-[50vh] w-[50rem] max-w-[80vw] overflow-auto font-mono text-sm">
        {error.message}
        <pre>
          <code>{error.stack}</code>
        </pre>
      </Sheet>
    </div>
  );
}
