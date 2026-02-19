import { EnterIcon, EyeNoneIcon, EyeOpenIcon } from "@radix-ui/react-icons";
import { Button } from "@ui/Button";
import { TextInput } from "@ui/TextInput";
import { useState } from "react";
import { useI18n } from "@common/lib/i18n";

export function DeploymentCredentialsForm({
  onSubmit,
  initialAdminKey,
  initialDeploymentUrl,
}: {
  onSubmit: ({
    submittedAdminKey,
    submittedDeploymentUrl,
    submittedDeploymentName,
  }: {
    submittedAdminKey: string;
    submittedDeploymentUrl: string;
    submittedDeploymentName: string;
  }) => Promise<void>;
  initialAdminKey: string | null;
  initialDeploymentUrl: string | null;
}) {
  const { t } = useI18n();
  const [draftAdminKey, setDraftAdminKey] = useState<string>(
    initialAdminKey ?? "",
  );
  const [draftDeploymentUrl, setDraftDeploymentUrl] = useState<string>(
    initialDeploymentUrl ?? "",
  );
  const [showKey, setShowKey] = useState(false);
  return (
    <form
      className="flex w-[30rem] flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({
          submittedAdminKey: draftAdminKey,
          submittedDeploymentUrl: draftDeploymentUrl,
          submittedDeploymentName: "",
        });
      }}
    >
      <TextInput
        id="deploymentUrl"
        label={t("auth.deploymentUrl")}
        value={draftDeploymentUrl}
        placeholder={t("auth.enterDeploymentUrl")}
        onChange={(e) => {
          setDraftDeploymentUrl(e.target.value);
        }}
      />
      <TextInput
        id="adminKey"
        label={t("auth.adminKey")}
        type={showKey ? "text" : "password"}
        Icon={showKey ? EyeNoneIcon : EyeOpenIcon}
        outerClassname="w-[30rem]"
        placeholder={t("auth.enterAdminKey")}
        value={draftAdminKey}
        action={() => {
          setShowKey(!showKey);
        }}
        description={t("auth.adminKeyRequired")}
        onChange={(e) => {
          setDraftAdminKey(e.target.value);
        }}
      />
      <Button
        type="submit"
        icon={<EnterIcon />}
        disabled={!draftAdminKey || !draftDeploymentUrl}
        size="xs"
        className="ml-auto w-fit"
      >
        {t("auth.logIn")}
      </Button>
    </form>
  );
}
