import { GatewayView } from "@common/features/gateway/components/GatewayView";

export default function GatewayPage({
  gatewayUrl,
}: {
  gatewayUrl?: string | null;
}) {
  return <GatewayView gatewayUrl={gatewayUrl} />;
}
