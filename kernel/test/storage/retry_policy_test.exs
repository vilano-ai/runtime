defmodule VilanoKernel.Storage.RetryPolicyTest do
  use ExUnit.Case, async: true

  alias VilanoKernel.Storage.RetryPolicy

  test "marks non-retryable failures explicitly" do
    decision =
      RetryPolicy.retry_decision(
        %{"family" => "application", "retryable" => false},
        1,
        3,
        ["always"]
      )

    assert decision["retryFamily"] == "application"
    refute decision["retryable"]
    refute decision["willRetry"]
    assert decision["retryDecision"] == "non_retryable"
  end

  test "rejects retry families that are not selected" do
    decision =
      RetryPolicy.retry_decision(
        %{"family" => "timeout"},
        1,
        3,
        ["application"]
      )

    refute decision["retryable"]
    refute decision["willRetry"]
    assert decision["retryDecision"] == "family_not_selected"
  end

  test "computes capped exponential backoff with jitter" do
    details =
      RetryPolicy.compute_backoff_details(
        %{
          "backoffKind" => "exponential",
          "backoffMs" => 100,
          "backoffFactor" => 2.0,
          "maxBackoffMs" => 250,
          "backoffJitterKind" => "half"
        },
        3,
        {"run_1", "step_a", 3}
      )

    assert details["backoffKind"] == "exponential"
    assert details["backoffBaseMs"] == 400
    assert details["backoffCappedMs"] == 250
    assert details["backoffCapMs"] == 250
    assert details["backoffJitterKind"] == "half"
    assert details["backoffJitterRatio"] == 0.5
    assert is_integer(details["backoffJitterMs"])
    assert details["backoffMs"] <= 250
  end
end
