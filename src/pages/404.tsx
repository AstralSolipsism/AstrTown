import { Button } from "@ui/Button";
import { useTranslation } from "@common/lib/i18n";

export default function Custom404() {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex gap-2 text-content-primary">
        <h2>404</h2>
        <div className="flex items-center gap-1 pl-2">
          <p>{t("selfHosted.errors.notFoundBody")}</p>
          <Button
            variant="unstyled"
            onClick={() => {
              window.location.href = "/";
            }}
            className="flex items-center underline"
          >
            {t("selfHosted.errors.goBack")}
          </Button>
        </div>
      </div>
    </div>
  );
}
