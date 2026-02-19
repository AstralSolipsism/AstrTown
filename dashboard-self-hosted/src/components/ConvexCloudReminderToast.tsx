import { useContext, useState } from "react";
import { DeploymentInfoContext } from "@common/lib/deploymentContext";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Cross2Icon,
  ExternalLinkIcon,
} from "@radix-ui/react-icons";
import { Button } from "@ui/Button";
import { CopyTextButton } from "@common/elements/CopyTextButton";
import Link from "next/link";
import { cn } from "@ui/cn";
import { useTranslation } from "@common/lib/i18n";

// Little toast to prompt users who are trying out Convex before creating
// an account about the Convex cloud product.
export function ConvexCloudReminderToast() {
  const { t } = useTranslation();
  const { useCurrentDeployment } = useContext(DeploymentInfoContext);
  const deployment = useCurrentDeployment();
  const isAnonymousDevelopment =
    deployment?.name?.startsWith("anonymous-") ||
    deployment?.name?.startsWith("tryitout-");
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  if (!isAnonymousDevelopment || isDismissed) {
    return null;
  }

  return (
    // Positioned in the bottom left corner, high enough to not block the
    // sidebar collapse button.
    <div className="absolute bottom-12 left-4 z-50">
      <div
        className="w-96 rounded-lg border border-purple-700 bg-background-secondary shadow-lg"
        role="region"
        aria-label={t("selfHosted.cloudReminder.toggleTitle")}
      >
        <div className="relative">
          <Button
            variant="unstyled"
            className={cn(
              "flex w-full cursor-pointer items-center justify-between rounded-lg p-2 text-sm font-medium text-purple-700 hover:bg-background-tertiary focus:ring-2 focus:ring-purple-700 focus:outline-hidden",
              isExpanded && "border-b border-purple-500",
            )}
            onClick={() => setIsExpanded(!isExpanded)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                setIsExpanded(!isExpanded);
              }
            }}
            aria-expanded={isExpanded}
            aria-controls="anonymous-development-details"
          >
            <div className="flex items-center gap-2">
              {isExpanded ? (
                <ChevronDownIcon className="h-4 w-4" />
              ) : (
                <ChevronRightIcon className="h-4 w-4" />
              )}
              <span>{t("selfHosted.cloudReminder.enjoyConvex")}</span>
            </div>
            <Button
              variant="unstyled"
              className="rounded-full p-1 text-purple-700 hover:bg-purple-100"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                setIsDismissed(true);
              }}
              aria-label={t("selfHosted.cloudReminder.dismiss")}
            >
              <Cross2Icon className="h-4 w-4" />
            </Button>
          </Button>
        </div>
        {isExpanded && (
          <div
            id="anonymous-development-details"
            className="flex flex-col gap-2 border-purple-500 px-4 py-3 text-sm text-content-primary"
          >
            <p>{t("selfHosted.cloudReminder.localTrialBody")}</p>
            <p>
              {t("selfHosted.cloudReminder.upgradeBody")}
            </p>
            <p className="inline-flex items-center gap-2">
              {t("selfHosted.cloudReminder.runInTerminal")}
              <CopyTextButton text="npx convex login" />
            </p>
            <Link
              href="https://docs.convex.dev"
              className="inline-flex items-center gap-2 text-content-link hover:underline"
              target="_blank"
            >
              {t("selfHosted.cloudReminder.learnMore")}
              <ExternalLinkIcon className="h-4 w-4" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
