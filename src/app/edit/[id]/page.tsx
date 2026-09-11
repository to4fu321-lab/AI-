import { EditReportScreen } from "@/features/EditReportScreen";

export default async function EditReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EditReportScreen id={id} />;
}
