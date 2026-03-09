defmodule VilanoKernel.Storage.ServiceLifecycleTest do
  use ExUnit.Case, async: true

  alias VilanoKernel.Storage.ServiceLifecycle

  test "keeps stopped services stopped when enqueueing" do
    assert ServiceLifecycle.enqueue_status("stopped", nil, "2026-03-08T00:00:00Z") == "stopped"
  end

  test "treats expired active leases as pending on enqueue" do
    assert ServiceLifecycle.enqueue_status(
             "active",
             "2026-03-08T00:00:00Z",
             "2026-03-08T00:00:01Z"
           ) == "pending"
  end

  test "moves a service back to pending when backlog remains" do
    assert ServiceLifecycle.next_status("active", true, false) == "pending"
  end

  test "derives resume reason from candidate state" do
    assert ServiceLifecycle.resume_reason(%{"run_status" => "pending"}) == "wait_satisfied"

    assert ServiceLifecycle.resume_reason(%{
             "run_status" => "active",
             "run_lease_expires_at" => "2026-03-08T00:00:00Z"
           }) == "lease_expired"

    assert ServiceLifecycle.resume_reason(%{"run_status" => "waiting"}) == "retry"
  end
end
