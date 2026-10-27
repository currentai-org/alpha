"""Tests that read deployment config this snapshot does not include.

They check the Fly deploy templates, the production config checker and the sandbox-pool alert
against files under `fly/` and the operations scripts, which are not published here.
"""

LEFT_OUT = {
    "api/test_agent_service.py::test_deploy_script_cannot_clobber_a_live_deployment",
    "api/test_agent_service.py::test_first_token_bound_is_declared_where_prodcheck_can_see_it",
    "api/test_agent_service.py::test_floor_exempts_its_own_synthetic_user",
    "api/test_agent_service.py::test_floor_warns_before_a_run_outgrows_the_task_cap",
    "api/test_agent_service.py::test_healthz_exposes_the_knobs_a_user_would_feel",
    "api/test_agent_service.py::test_healthz_reports_repair_turns_so_the_running_app_can_be_asked",
    "api/test_agent_service.py::test_hermes_patches_are_applied_by_the_build_not_just_stored",
    "api/test_agent_service.py::test_keep_workdir_is_off_and_compared_in_both_directions",
    "api/test_agent_service.py::test_live_probe_does_not_cry_wolf_on_a_disabled_cap",
    "api/test_agent_service.py::test_one_judge_call_cannot_outlast_the_turn_it_is_judging",
    "api/test_agent_service.py::test_operator_subs_compare_by_membership_not_by_string",
    "api/test_agent_service.py::test_prod_smoke_reads_its_token_without_printing_it",
    "api/test_agent_service.py::test_prodcheck_allows_a_declared_divergence_only_at_the_declared_value",
    "api/test_agent_service.py::test_prodcheck_catches_the_four_mistakes_that_actually_happened",
    "api/test_agent_service.py::test_prodcheck_compares_set_valued_knobs_by_membership",
    "api/test_agent_service.py::test_prodcheck_compares_the_new_trust_thresholds",
    "api/test_agent_service.py::test_prodcheck_prefers_the_deployed_config_over_the_template",
    "api/test_agent_service.py::test_prodcheck_probes_the_live_app_once_per_run",
    "api/test_agent_service.py::test_prodcheck_probes_the_running_app_not_only_the_config_file",
    "api/test_agent_service.py::test_prodcheck_reads_the_build_out_of_the_same_probe_it_reads_the_knobs_from",
    "api/test_agent_service.py::test_prodcheck_reads_the_proxy_config_not_just_the_app_config",
    "api/test_agent_service.py::test_prodcheck_reports_template_vs_deployed_drift",
    "api/test_agent_service.py::test_prodcheck_says_a_deadline_has_never_been_sent_rather_than_staying_quiet",
    "api/test_agent_service.py::test_prodcheck_source_admits_when_it_is_reading_a_template",
    "api/test_agent_service.py::test_prodcheck_tracks_a_hermes_flag_in_whichever_direction_prod_moved",
    "api/test_agent_service.py::test_stale_deploy_compares_counted_fields_by_cardinality",
    "api/test_agent_service.py::test_the_fallback_allowlist_is_never_wider_than_what_ships",
    "api/test_agent_service.py::test_the_harness_watches_a_trial_for_as_long_as_the_task_may_run",
    "api/test_agent_service.py::test_the_running_app_settles_a_knob_the_config_file_leaves_unstated",
    "api/test_agent_service.py::test_the_wall_clock_anchor_is_inherited_from_hermes_not_owned_here",
    "api/test_agent_service.py::test_verifier_bakeoff_provenance_summary",
    "api/test_agent_service.py::test_verifier_model_and_its_route_are_configured_as_a_pair",
    "api/test_isolation_config.py::test_a_retired_key_left_in_the_deployed_copy_is_a_note_not_a_deploy_blocking_finding",
    "api/test_isolation_config.py::test_prodcheck_requires_the_bwrap_profile_only_where_bwrap_runs",
    "api/test_isolation_config.py::test_the_fly_template_sets_no_bwrap_profile_knob",
    "api/test_sandbox_pool_alert.py::test_a_host_at_four_fifths_of_its_capacity_for_several_readings_posts_the_near_full_alert",
    "api/test_sandbox_pool_alert.py::test_a_quiet_dataset_posts_neither_sandbox_alert",
    "api/test_sandbox_pool_alert.py::test_a_single_passing_reading_at_four_fifths_does_not_post_the_near_full_alert",
    "api/test_sandbox_pool_alert.py::test_refused_creates_post_the_host_refusing_alert_without_any_capacity_setting",
}


def pytest_collection_modifyitems(config, items):
    kept = [item for item in items if item.nodeid not in LEFT_OUT]
    left_out = [item for item in items if item.nodeid in LEFT_OUT]
    if left_out:
        config.hook.pytest_deselected(items=left_out)
        items[:] = kept
