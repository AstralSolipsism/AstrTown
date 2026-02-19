import { Sheet } from "@ui/Sheet";
import { Button } from "@ui/Button";
import {
  DeploymentUrl,
  HttpActionsUrl,
} from "@common/features/settings/components/DeploymentUrl";
import { DeploymentSettingsLayout } from "@common/layouts/DeploymentSettingsLayout";
import Link from "next/link";
import { useContext, useRef } from "react";
import { DeploymentInfoContext } from "@common/lib/deploymentContext";
import { CopyTextButton } from "@common/elements/CopyTextButton";
import { PauseDeployment } from "@common/features/settings/components/PauseDeployment";
import { useScrollToHash } from "@common/lib/useScrollToHash";
import { useI18n } from "@common/lib/i18n";

export default function Settings() {
  const { t, language, setLanguage } = useI18n();
  const { useCurrentDeployment } = useContext(DeploymentInfoContext);
  const deployment = useCurrentDeployment();
  const isAnonymousDeployment =
    deployment?.name?.startsWith("anonymous-") ||
    deployment?.name?.startsWith("tryitout-");
  const pauseDeploymentRef = useRef<HTMLDivElement | null>(null);

  useScrollToHash("#pause-deployment", pauseDeploymentRef);

  return (
    <DeploymentSettingsLayout page="general">
      <div className="flex flex-col gap-4">
        <Sheet>
          <DeploymentUrl>
            {t("settingsGeneral.configureClientWithUrl")}
          </DeploymentUrl>
        </Sheet>
        <Sheet>
          <HttpActionsUrl />
        </Sheet>
        <Sheet>
          <div className="flex flex-col gap-4 text-content-primary">
            <div className="flex flex-col gap-2">
              <h4>{t("settings.language.title")}</h4>
              <p className="max-w-prose text-content-secondary">
                {t("settings.language.description")}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant={language === "zh-CN" ? "primary" : "neutral"}
                className="justify-between"
                onClick={() => setLanguage("zh-CN")}
              >
                <span>{t("settings.language.chinese")}</span>
                {language === "zh-CN" && (
                  <span className="rounded-sm border px-1.5 py-0.5 text-xs">
                    {t("settings.language.current")}
                  </span>
                )}
              </Button>
              <Button
                variant={language === "en" ? "primary" : "neutral"}
                className="justify-between"
                onClick={() => setLanguage("en")}
              >
                <span>{t("settings.language.english")}</span>
                {language === "en" && (
                  <span className="rounded-sm border px-1.5 py-0.5 text-xs">
                    {t("settings.language.current")}
                  </span>
                )}
              </Button>
            </div>
          </div>
        </Sheet>
        <Sheet>
          <div className="flex flex-col gap-2 text-content-primary">
            <h4 className="mb-4">{t("settingsGeneral.deployKey")}</h4>

            <p className="max-w-prose text-content-secondary">
              {t("settingsGeneral.deployKeysOnlyCloud")}
            </p>
            {isAnonymousDeployment ? (
              <>
                <p className="max-w-prose text-content-primary">
                  {t("settingsGeneral.createAccountAndLinkDeployment")}
                </p>

                <CopyTextButton className="text-sm" text="npx convex login" />
                <Link
                  href="https://docs.convex.dev/production/hosting/"
                  target="_blank"
                  className="text-content-link hover:underline"
                >
                  {t("settingsGeneral.learnMore")}
                </Link>
              </>
            ) : (
              <p className="mt-1 max-w-prose text-content-primary">
                {t("settingsGeneral.insteadGenerateAdminKey")} {" "}
                <Link
                  href="https://github.com/get-convex/convex-backend/tree/main/self-hosted#docker-configuration"
                  className="text-content-link hover:underline"
                >
                  {t("settingsGeneral.scriptInRepository")}
                </Link>
                .
              </p>
            )}
          </div>
        </Sheet>
        <div ref={pauseDeploymentRef}>
          <PauseDeployment />
        </div>
      </div>
    </DeploymentSettingsLayout>
  );
}
