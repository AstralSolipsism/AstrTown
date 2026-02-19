// eslint-disable-next-line import/no-relative-packages
import "../../../@convex-dev/design-system/src/styles/shared.css";
// eslint-disable-next-line import/no-relative-packages
import "../../../dashboard-common/src/styles/globals.css";
import { AppProps } from "next/app";
import Head from "next/head";
import { useQuery } from "convex/react";
import udfs from "@common/udfs";
import { useSessionStorage } from "react-use";
import { ExitIcon, GearIcon } from "@radix-ui/react-icons";
import { ConvexLogo } from "@common/elements/ConvexLogo";
import { ToastContainer } from "@common/elements/ToastContainer";
import { ThemeConsumer } from "@common/elements/ThemeConsumer";
import { Favicon } from "@common/elements/Favicon";
import { ToggleTheme } from "@common/elements/ToggleTheme";
import { Menu, MenuItem } from "@ui/Menu";
import { ThemeProvider } from "next-themes";
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  createContext,
} from "react";
import { ErrorBoundary } from "components/ErrorBoundary";
import { DeploymentDashboardLayout } from "@common/layouts/DeploymentDashboardLayout";
import {
  DeploymentApiProvider,
  WaitForDeploymentApi,
  DeploymentInfo,
  DeploymentInfoContext,
  SelfHostedDisconnectOverlay,
} from "@common/lib/deploymentContext";
import { Tooltip } from "@ui/Tooltip";
import { DeploymentCredentialsForm } from "components/DeploymentCredentialsForm";
import { DeploymentList } from "components/DeploymentList";
import { checkDeploymentInfo } from "lib/checkDeploymentInfo";
import { ConvexCloudReminderToast } from "components/ConvexCloudReminderToast";
import { z } from "zod";
import { UIProvider } from "@ui/UIContext";
import Link from "next/link";
import { I18nProvider, Language, useI18n, useTranslation } from "@common/lib/i18n";
import type { TranslationValues } from "@common/lib/i18n/types";

if (process.env.NEXT_PUBLIC_LOAD_MONACO_INTERNALLY === "true") {
  import("../lib/monacoInternalLoader").then((a) => a).catch(console.error);
}

// Context for self-hosted dashboard sidebar settings
const SelfHostedSettingsContext = createContext<{
  visiblePages?: string[];
}>({
  visiblePages: undefined,
});

/**
 * Wrapper component that consumes SelfHostedSettingsContext and passes
 * the settings to DeploymentDashboardLayout
 */
function DeploymentDashboardLayoutWrapper({
  children,
}: {
  children: JSX.Element;
}) {
  const { visiblePages } = useContext(SelfHostedSettingsContext);

  return (
    <DeploymentDashboardLayout visiblePages={visiblePages}>
      {children}
    </DeploymentDashboardLayout>
  );
}

function App({
  Component,
  pageProps: {
    deploymentUrl,
    adminKey,
    defaultListDeploymentsApiUrl,
    ...pageProps
  },
}: AppProps & {
  pageProps: {
    deploymentUrl: string | null;
    adminKey: string | null;
    defaultListDeploymentsApiUrl: string | null;
  };
}) {
  const { t } = useTranslation();
  const [language, setLanguage] = useState<Language>("zh-CN");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const storedLanguage = window.localStorage.getItem("dashboard.language");
    if (storedLanguage === "en" || storedLanguage === "zh-CN") {
      setLanguage(storedLanguage);
    }
  }, []);

  const setLanguageAndPersist = useCallback((nextLanguage: Language) => {
    setLanguage(nextLanguage);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dashboard.language", nextLanguage);
    }
  }, []);

  return (
    <>
      <Head>
        <title>{t("selfHosted.app.title")}</title>
        <meta name="description" content={t("selfHosted.app.metaDescription")} />
        <Favicon />
      </Head>
      <I18nProvider language={language} setLanguage={setLanguageAndPersist}>
        <UIProvider Link={Link}>
          <ThemeProvider attribute="class" disableTransitionOnChange>
            <ThemeConsumer />
            <ToastContainer />
            <div className="flex h-screen flex-col">
              <DeploymentInfoProvider
                deploymentUrl={deploymentUrl}
                adminKey={adminKey}
                defaultListDeploymentsApiUrl={defaultListDeploymentsApiUrl}
              >
                <DeploymentApiProvider deploymentOverride="local">
                  <WaitForDeploymentApi>
                    <DeploymentDashboardLayoutWrapper>
                      <>
                        <Component {...pageProps} />
                        <ConvexCloudReminderToast />
                      </>
                    </DeploymentDashboardLayoutWrapper>
                  </WaitForDeploymentApi>
                </DeploymentApiProvider>
              </DeploymentInfoProvider>
            </div>
          </ThemeProvider>
        </UIProvider>
      </I18nProvider>
    </>
  );
}

const LIST_DEPLOYMENTS_API_PORT_QUERY_PARAM = "a";
const SELECTED_DEPLOYMENT_NAME_QUERY_PARAM = "d";
const SESSION_STORAGE_DEPLOYMENT_NAME_KEY = "deploymentName";

function normalizeUrl(url: string) {
  try {
    const parsedUrl = new URL(url);
    // remove trailing slash
    return parsedUrl.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

App.getInitialProps = async ({ ctx }: { ctx: { req?: any } }) => {
  // On server-side, get from process.env
  if (ctx.req) {
    // Note -- we can't use `ctx.req.url` when serving the dashboard statically,
    // so instead we'll read from query params on the client side.

    let deploymentUrl: string | null = null;
    if (process.env.NEXT_PUBLIC_DEPLOYMENT_URL) {
      deploymentUrl = normalizeUrl(process.env.NEXT_PUBLIC_DEPLOYMENT_URL);
    }
    let gatewayUrl: string | null = null;
    if (process.env.NEXT_PUBLIC_GATEWAY_URL) {
      gatewayUrl = normalizeUrl(process.env.NEXT_PUBLIC_GATEWAY_URL);
    }
    let adminKey: string | null = null;
    if (process.env.NEXT_PUBLIC_ADMIN_KEY) {
      adminKey = process.env.NEXT_PUBLIC_ADMIN_KEY;
    }

    const listDeploymentsApiPort =
      process.env.NEXT_PUBLIC_DEFAULT_LIST_DEPLOYMENTS_API_PORT;
    let listDeploymentsApiUrl: string | null = null;
    if (listDeploymentsApiPort) {
      const port = parseInt(listDeploymentsApiPort);
      if (!Number.isNaN(port)) {
        listDeploymentsApiUrl = normalizeUrl(`http://127.0.0.1:${port}`);
      }
    }

    return {
      pageProps: {
        deploymentUrl,
        gatewayUrl,
        adminKey,
        defaultListDeploymentsApiUrl: listDeploymentsApiUrl,
      },
    };
  }

  // On client-side navigation, get from window.__NEXT_DATA__
  const clientSideDeploymentUrl =
    window.__NEXT_DATA__?.props?.pageProps?.deploymentUrl ?? null;
  const clientSideGatewayUrl =
    window.__NEXT_DATA__?.props?.pageProps?.gatewayUrl ?? null;
  const clientSideAdminKey =
    window.__NEXT_DATA__?.props?.pageProps?.adminKey ?? null;
  const clientSideListDeploymentsApiUrl =
    window.__NEXT_DATA__?.props?.pageProps?.listDeploymentsApiUrl ?? null;
  const clientSideSelectedDeploymentName =
    window.__NEXT_DATA__?.props?.pageProps?.selectedDeploymentName ?? null;
  return {
    pageProps: {
      deploymentUrl: clientSideDeploymentUrl ?? null,
      gatewayUrl: clientSideGatewayUrl ?? null,
      adminKey: clientSideAdminKey ?? null,
      defaultListDeploymentsApiUrl: clientSideListDeploymentsApiUrl ?? null,
      selectedDeploymentName: clientSideSelectedDeploymentName ?? null,
    },
  };
};

export default App;

function createDeploymentInfo(
  t: (key: string, values?: TranslationValues) => string,
): Omit<DeploymentInfo, "deploymentUrl" | "adminKey"> {
  return {
    ok: true,
    addBreadcrumb: console.error,
    captureMessage: console.error,
    captureException: console.error,
    reportHttpError: (
      method: string,
      url: string,
      error: { code: string; message: string },
    ) => {
      console.error(
        `failed to request ${method} ${url}: ${error.code} - ${error.message} `,
      );
    },
    useCurrentTeam: () => ({
      id: 0,
      name: t("selfHosted.app.teamFallbackName"),
      slug: "team",
    }),
    useTeamMembers: () => [],
    useTeamEntitlements: () => ({
      auditLogRetentionDays: -1,
      logStreamingEnabled: true,
      streamingExportEnabled: true,
    }),
    useCurrentUsageBanner: () => null,
    useCurrentProject: () => ({
      id: 0,
      name: t("selfHosted.app.projectFallbackName"),
      slug: "project",
      teamId: 0,
    }),
    useCurrentDeployment: () => {
      const [storedDeploymentName] = useSessionStorage(
        SESSION_STORAGE_DEPLOYMENT_NAME_KEY,
        "",
      );
      return {
        id: 0,
        name: storedDeploymentName,
        deploymentType: "dev",
        projectId: 0,
        kind: "local",
        previewIdentifier: null,
      };
    },
    useIsProtectedDeployment: () => false,
    useHasProjectAdminPermissions: () => true,
    useIsDeploymentPaused: () => {
      const deploymentState = useQuery(udfs.deploymentState.deploymentState);
      return deploymentState?.state === "paused";
    },
    useProjectEnvironmentVariables: () => ({ configs: [] }),
    // no-op. don't send analytics in the self-hosted dashboard.
    useLogDeploymentEvent: () => () => {},
    workOSOperations: {
      useDeploymentWorkOSEnvironment: () => undefined,
      useTeamWorkOSIntegration: () => undefined,
      useWorkOSTeamHealth: () => undefined,
      useWorkOSEnvironmentHealth: () => ({ data: undefined, error: undefined }),
      useDisconnectWorkOSTeam: (_teamId?: string) => async () => undefined,
      useInviteWorkOSTeamMember: () => async () => undefined,
      useWorkOSInvitationEligibleEmails: () => undefined,
      useAvailableWorkOSTeamEmails: () => undefined,
      useProvisionWorkOSTeam: (_teamId?: string) => async () => undefined,
      useProvisionWorkOSEnvironment: (_deploymentName?: string) => async () =>
        undefined,
      useDeleteWorkOSEnvironment: (_deploymentName?: string) => async () =>
        undefined,
      useProjectWorkOSEnvironments: (_projectId?: number) => undefined,
      useGetProjectWorkOSEnvironment: (
        _projectId?: number,
        _clientId?: string,
      ) => undefined,
      useCheckProjectEnvironmentHealth:
        (_projectId?: number, _clientId?: string) =>
        async () =>
          null,
      useProvisionProjectWorkOSEnvironment:
        (_projectId?: number) => async (_body: { environmentName: string }) => ({
          workosEnvironmentId: "",
          workosEnvironmentName: "",
          workosClientId: "",
          workosApiKey: "",
          newlyProvisioned: false,
          userEnvironmentName: "",
        }),
      useDeleteProjectWorkOSEnvironment:
        (_projectId?: number) => async (_clientId: string) => ({
          workosEnvironmentId: "",
          workosEnvironmentName: "",
          workosTeamId: "",
        }),
    },
    CloudImport: ({ sourceCloudBackupId }: { sourceCloudBackupId: number }) => (
      <div>{sourceCloudBackupId}</div>
    ),
    TeamMemberLink: () => (
      <Tooltip tip={t("selfHosted.app.identityNotAvailable")}>
        <div className="underline decoration-dotted underline-offset-4">
          {t("selfHosted.app.adminLabel")}
        </div>
      </Tooltip>
    ),
    ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
      <ErrorBoundary>{children}</ErrorBoundary>
    ),
    DisconnectOverlay: () => <SelfHostedDisconnectOverlay />,
    useTeamUsageState: () => "Default",
    teamsURI: "",
    projectsURI: "",
    deploymentsURI: "",
    isSelfHosted: true,
    workosIntegrationEnabled: false,
    connectionStateCheckIntervalMs: 2500,
  };
}

function DeploymentInfoProvider({
  children,
  deploymentUrl,
  adminKey,
  defaultListDeploymentsApiUrl,
}: {
  children: React.ReactNode;
  deploymentUrl: string | null;
  adminKey: string | null;
  defaultListDeploymentsApiUrl: string | null;
}) {
  const { t } = useTranslation();
  const [listDeploymentsApiUrl, setListDeploymentsApiUrl] = useState<
    string | null
  >(null);
  const [selectedDeploymentName, setSelectedDeploymentName] = useState<
    string | null
  >(null);
  const [isValidDeploymentInfo, setIsValidDeploymentInfo] = useState<
    boolean | null
  >(null);
  const [storedAdminKey, setStoredAdminKey] = useSessionStorage("adminKey", "");
  const [storedDeploymentUrl, setStoredDeploymentUrl] = useSessionStorage(
    "deploymentUrl",
    "",
  );
  const [_storedDeploymentName, setStoredDeploymentName] = useSessionStorage(
    SESSION_STORAGE_DEPLOYMENT_NAME_KEY,
    "",
  );
  const [visiblePages, setVisiblePages] = useState<string[] | undefined>(
    undefined,
  );

  // Memoize this so it can safely be passed into the context
  const settingsContextValue = useMemo(
    () => ({ visiblePages }),
    [visiblePages],
  );

  const onSubmit = useCallback(
    async ({
      submittedAdminKey,
      submittedDeploymentUrl,
      submittedDeploymentName,
      submittedVisiblePages,
    }: {
      submittedAdminKey: string;
      submittedDeploymentUrl: string;
      submittedDeploymentName: string;
      submittedVisiblePages?: string[];
    }) => {
      const isValid = await checkDeploymentInfo(
        submittedAdminKey,
        submittedDeploymentUrl,
      );
      if (isValid === false) {
        setIsValidDeploymentInfo(false);
        return;
      }
      // For deployments that don't have the `/check_admin_key` endpoint,
      // we set isValidDeploymentInfo to true so we can move on. The dashboard
      // will just hit a less graceful error later if the credentials are invalid.
      setIsValidDeploymentInfo(true);
      setStoredAdminKey(submittedAdminKey);
      setStoredDeploymentUrl(submittedDeploymentUrl);
      setStoredDeploymentName(submittedDeploymentName);
      setVisiblePages(submittedVisiblePages);
    },
    [setStoredAdminKey, setStoredDeploymentUrl, setStoredDeploymentName],
  );

  useEmbeddedDashboardCredentials(onSubmit);

  const finalValue: DeploymentInfo = useMemo(
    () =>
      ({
        ...createDeploymentInfo(t),
        ok: true,
        adminKey: storedAdminKey,
        deploymentUrl: storedDeploymentUrl,
      }) as DeploymentInfo,
    [storedAdminKey, storedDeploymentUrl, t],
  );
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    let cancelled = false;

    const restoreDeploymentInfo = async () => {
      const rawSessionAdminKey = window.sessionStorage.getItem("adminKey");
      const rawSessionDeploymentUrl =
        window.sessionStorage.getItem("deploymentUrl");

      const parseStoredValue = (rawValue: string | null) => {
        if (!rawValue) {
          return "";
        }
        try {
          const parsed = JSON.parse(rawValue);
          return typeof parsed === "string" ? parsed : "";
        } catch {
          return rawValue;
        }
      };

      const sessionAdminKey = parseStoredValue(rawSessionAdminKey);
      const sessionDeploymentUrl = parseStoredValue(rawSessionDeploymentUrl);

      const adminKeyToCheck = sessionAdminKey || adminKey || "";
      const deploymentUrlToCheck = sessionDeploymentUrl || deploymentUrl || "";

      if (!adminKeyToCheck || !deploymentUrlToCheck) {
        if (!cancelled) {
          setIsValidDeploymentInfo(false);
        }
        return;
      }

      const isValid = await checkDeploymentInfo(
        adminKeyToCheck,
        deploymentUrlToCheck,
      );

      if (cancelled) {
        return;
      }

      if (isValid === false) {
        setStoredAdminKey("");
        setStoredDeploymentUrl("");
        setStoredDeploymentName("");
        setIsValidDeploymentInfo(false);
        return;
      }

      // A null result means `/check_admin_key` is unavailable; keep existing behavior
      // and allow the dashboard to continue.
      setStoredAdminKey(adminKeyToCheck);
      setStoredDeploymentUrl(deploymentUrlToCheck);
      setIsValidDeploymentInfo(true);
    };

    void restoreDeploymentInfo();

    return () => {
      cancelled = true;
    };
  }, [
    adminKey,
    deploymentUrl,
    setStoredAdminKey,
    setStoredDeploymentUrl,
    setStoredDeploymentName,
  ]);
  useEffect(() => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      const listDeploymentsApiPort = url.searchParams.get(
        LIST_DEPLOYMENTS_API_PORT_QUERY_PARAM,
      );
      const selectedDeploymentNameFromUrl = url.searchParams.get(
        SELECTED_DEPLOYMENT_NAME_QUERY_PARAM,
      );
      url.searchParams.delete(LIST_DEPLOYMENTS_API_PORT_QUERY_PARAM);
      url.searchParams.delete(SELECTED_DEPLOYMENT_NAME_QUERY_PARAM);
      window.history.replaceState({}, "", url.toString());
      if (listDeploymentsApiPort) {
        if (!Number.isNaN(parseInt(listDeploymentsApiPort))) {
          setListDeploymentsApiUrl(
            normalizeUrl(`http://127.0.0.1:${listDeploymentsApiPort}`),
          );
        }
      } else {
        setListDeploymentsApiUrl(defaultListDeploymentsApiUrl);
      }
      if (selectedDeploymentNameFromUrl) {
        setSelectedDeploymentName(selectedDeploymentNameFromUrl);
      }
    }
  }, [defaultListDeploymentsApiUrl]);
  if (!mounted) return null;

  if (isValidDeploymentInfo === null) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4">
        <ConvexLogo />
        <div className="text-sm text-content-secondary">
          {t("auth.checkingDeploymentCredentials")}
        </div>
      </div>
    );
  }

  if (!isValidDeploymentInfo) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-8">
        <ConvexLogo />
        {listDeploymentsApiUrl !== null ? (
          <DeploymentList
            listDeploymentsApiUrl={listDeploymentsApiUrl}
            onError={() => {
              setListDeploymentsApiUrl(null);
            }}
            onSelect={onSubmit}
            selectedDeploymentName={selectedDeploymentName}
          />
        ) : (
          <DeploymentCredentialsForm
            onSubmit={onSubmit}
            initialAdminKey={adminKey}
            initialDeploymentUrl={deploymentUrl}
          />
        )}
        {isValidDeploymentInfo === false && (
          <div className="text-sm text-content-secondary">
            {t("auth.invalidDeploymentCredentials")}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <Header
        onLogout={() => {
          setStoredAdminKey("");
          setStoredDeploymentUrl("");
          setStoredDeploymentName("");
          setIsValidDeploymentInfo(false);
        }}
      />
      <DeploymentInfoContext.Provider value={finalValue}>
        <SelfHostedSettingsContext.Provider value={settingsContextValue}>
          <ErrorBoundary>{children}</ErrorBoundary>
        </SelfHostedSettingsContext.Provider>
      </DeploymentInfoContext.Provider>
    </>
  );
}

function Header({ onLogout }: { onLogout: () => void }) {
  const { language, setLanguage, t } = useI18n();
  if (process.env.NEXT_PUBLIC_HIDE_HEADER) {
    return null;
  }

  return (
    <header className="-ml-1 scrollbar-none flex min-h-[56px] items-center justify-between gap-1 overflow-x-auto border-b bg-background-secondary pr-4 sm:gap-6">
      <ConvexLogo height={64} width={192} />
      <Menu
        buttonProps={{
          icon: (
            <GearIcon className="h-7 w-7 rounded-sm p-1 text-content-primary hover:bg-background-tertiary" />
          ),
          variant: "unstyled",
          "aria-label": t("header.dashboardSettings"),
        }}
        placement="bottom-end"
      >
        <MenuItem
          action={() => {
            setLanguage(language === "zh-CN" ? "en" : "zh-CN");
          }}
        >
          {language === "zh-CN"
            ? t("header.switchToEnglish")
            : t("header.switchToChinese")}
        </MenuItem>
        <ToggleTheme />
        <MenuItem action={onLogout}>
          <div className="flex w-full items-center justify-between">
            {t("header.logOut")}
            <ExitIcon className="text-content-secondary" />
          </div>
        </MenuItem>
      </Menu>
    </header>
  );
}

/**
 * Allow the parent window to send credentials to the dashboard.
 * This is used when the dashboard is embedded in another application via an iframe.
 */
function useEmbeddedDashboardCredentials(
  onSubmit: ({
    submittedAdminKey,
    submittedDeploymentUrl,
    submittedDeploymentName,
    submittedVisiblePages,
  }: {
    submittedAdminKey: string;
    submittedDeploymentUrl: string;
    submittedDeploymentName: string;
    submittedVisiblePages?: string[];
  }) => void,
) {
  // Send a message to the parent iframe to request the credentials.
  // This prevents race conditions where the parent iframe sends the message
  // before the dashboard loads.
  useEffect(() => {
    window.parent.postMessage(
      {
        type: "dashboard-credentials-request",
      },
      "*",
    );
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const credentialsSchema = z.object({
        type: z.literal("dashboard-credentials"),
        adminKey: z.string(),
        deploymentUrl: z.string().url(),
        deploymentName: z.string(),
        visiblePages: z.array(z.string()).optional(),
      });

      try {
        credentialsSchema.parse(event.data);
      } catch {
        return;
      }

      if (event.data.type === "dashboard-credentials") {
        onSubmit({
          submittedAdminKey: event.data.adminKey,
          submittedDeploymentUrl: event.data.deploymentUrl,
          submittedDeploymentName: event.data.deploymentName,
          submittedVisiblePages: event.data.visiblePages,
        });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [onSubmit]);
}
