import { HealthView } from "@common/features/health/components/HealthView";
import { useTranslation } from "@common/lib/i18n";

export default function Page() {
  const { t } = useTranslation();
  return (
    <HealthView
      header={
        <h3 className="sticky top-0 mx-6 pt-4 pb-2">
          {t("selfHosted.health.title")}
        </h3>
      }
      PagesWrapper={({ children }) => (
        <div className="flex min-h-0 grow">{children}</div>
      )}
      PageWrapper={({ children }) => (
        <div className="scrollbar max-w-full shrink-0 grow overflow-y-auto px-6 pb-4">
          {children}
        </div>
      )}
    />
  );
}
