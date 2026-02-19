import { Callout } from "@ui/Callout";
import { useTranslation } from "@common/lib/i18n";

export default function Custom500() {
  return <Fallback error={null} />;
}

export function Fallback({ error }: { error: Error | null }) {
  const { t } = useTranslation();
  return (
    <div className="h-full grow">
      <div className="flex h-full flex-col items-center justify-center">
        <Callout variant="error">
          <div className="flex flex-col gap-2">
            <p>{t("selfHosted.errors.pageLoadFailed")}</p>
            {error && <code>{error.toString()}</code>}
          </div>
        </Callout>
      </div>
    </div>
  );
}
