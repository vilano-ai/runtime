defmodule VilanoKernel.Router.PublicHandlers do
  @moduledoc false

  alias VilanoKernel.Router.ProjectHandlers
  alias VilanoKernel.Router.RunHandlers
  alias VilanoKernel.Router.RuntimeViews
  alias VilanoKernel.Router.ServiceHandlers

  import VilanoKernel.Router.Support

  def status(conn) do
    send_json(conn, 200, RuntimeViews.status_payload())
  end

  def runtime_debug(conn) do
    send_json(conn, 200, RuntimeViews.runtime_debug_payload())
  end

  def runtime_storage(conn) do
    send_json(conn, 200, RuntimeViews.runtime_storage_payload())
  end

  def shutdown(conn) do
    conn = send_json(conn, 200, %{ok: true, shuttingDown: true})

    _ =
      Task.start(fn ->
        Process.sleep(50)
        System.stop(0)
      end)

    conn
  end

  def project_snapshots(conn) do
    project_name =
      conn
      |> Plug.Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    send_json(conn, 200, RuntimeViews.project_snapshots_payload(project_name))
  end

  defdelegate list_projects(conn), to: ProjectHandlers
  defdelegate create_project(conn), to: ProjectHandlers
  defdelegate get_project(conn, name), to: ProjectHandlers
  defdelegate sync_project(conn, name), to: ProjectHandlers
  defdelegate delete_project(conn, name), to: ProjectHandlers
  defdelegate purge_project_runtime(conn, name), to: ProjectHandlers
  defdelegate list_workflows(conn), to: ProjectHandlers
  defdelegate list_services(conn), to: ProjectHandlers
  defdelegate list_service_runs(conn), to: ProjectHandlers
  defdelegate get_workflow_definition(conn, project, name), to: ProjectHandlers

  defdelegate inspect_service_run(conn, project, name, service_key), to: ServiceHandlers
  defdelegate get_service_envelope(conn, id), to: ServiceHandlers
  defdelegate ensure_service(conn), to: ServiceHandlers
  defdelegate enqueue_service_send(conn, project, name, service_key), to: ServiceHandlers
  defdelegate enqueue_service_ask(conn, project, name, service_key), to: ServiceHandlers
  defdelegate enqueue_service_signal(conn, project, name, service_key), to: ServiceHandlers
  defdelegate stop_service(conn, project, name, service_key), to: ServiceHandlers

  defdelegate create_run(conn), to: RunHandlers
  defdelegate list_runs(conn), to: RunHandlers
  defdelegate inspect_run(conn, id), to: RunHandlers
  defdelegate replay_run(conn, id), to: RunHandlers
  defdelegate cancel_run(conn, id), to: RunHandlers
  defdelegate signal_run(conn, id), to: RunHandlers
end
