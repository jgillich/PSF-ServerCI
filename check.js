import * as build from './build.js'
import logger from "./log.js"
import * as db from './db.js'
import * as instance from "./instance.js"
import app_config from "./app_config.js"
import fs from 'fs'

export async function handle_check_run(octokit, action, github_ctx_base, github_ctx_head, check_suite, check_run) {
	var log;

	const job_ctx = {
		check_suite_id : check_suite.id
	};

	// are we updating an old run?
	if (check_run) {
		job_ctx.check_run_id = check_run.id;
		log = logger.child({checkSuite : job_ctx.check_suite_id, checkRun: job_ctx.check_run_id})
	} else {
		log = logger.child({checkSuite : job_ctx.check_suite_id})
	}

	log.info("Check run event. action='%s', branch='%s' url='%s'",
		action, github_ctx_head.branch, github_ctx_head.url);

	if (action === "requested") {
		// create new check run and replace old (for a new or re-request)
		try {
			check_run = await create_check_run(octokit, github_ctx_base, github_ctx_head.head_sha, "Test Server")
		} catch(e) {
			log.error("Unable to create check_run: ", e);
			return;
		}

		try {
			job_ctx.job_id = await db.create_job(github_ctx_base, github_ctx_head, job_ctx);
		} catch (e) {
			log.error("Unable to create job in DB: ", e)
			return;
		}
	} else if (action === "rerequested") {
		const jobs = await db.get_jobs_by_suite(job_ctx.check_suite_id);

		if (jobs.length === 0) {
			log.error("Unable to find existing check_suite upon re-run request");
			return;
		}

		const job = jobs[0];
		job_ctx.job_id = job.id;

		log.info("Rerunning job %d", job_ctx.job_id)

		github_ctx_base.url = job.base_url;
		github_ctx_base.head_sha = job.base_sha;
		github_ctx_base.branch = job.base_branch;

		github_ctx_head.url = job.head_url;
		github_ctx_head.head_sha = job.head_sha;
		github_ctx_head.branch = job.head_branch;
		// TODO: update owner + repo fields
		// TODO: stop old or inprogress jobs and clean up

		// create new check run and replace old (for a new or re-request)
		try {
			check_run = await create_check_run(octokit, github_ctx_base, github_ctx_head.head_sha, "Test Server")
		} catch(e) {
			log.error("Unable to create check_run: ", e);
			return;
		}
	// TODO: requested_action
	} else {
		log.error("Unhandled check run action='%s'", action);
		return;
	}

	check_run = check_run.data;
	job_ctx.check_run_id = check_run.id;

	log = logger.child({ checkSuite : job_ctx.check_suite_id, checkRun: job_ctx.check_run_id, jobId: job_ctx.job_id })

	const old_instances = await db.get_instances_by_gref(github_ctx_head.url + ":" + github_ctx_head.branch);
	const {job_output, job_result} = await build_instance(log, octokit, github_ctx_head, job_ctx);

	log.info(job_output.join("\n"));

	try {
		if (job_result) {
			// TODO: ONLY stop old instances if the new instance is the latest
			if (old_instances.length) {
				log.info("Stopping %d previous instances", old_instances.length)

				for (let i = 0; i < old_instances.length; i++)
					await instance.stop(old_instances[i])
			}

			log.info("Instance build completed")

			const result = await octokit.checks.update({
				owner : github_ctx_base.owner,
				repo : github_ctx_base.repo,
				check_run_id : job_ctx.check_run_id,
				status: "completed",
				conclusion : "success",
				output : {
					title : "Server Instance Running",
					summary : "`Log output`",
				},
				actions : [
					{ label : "Stop Server", description : "Stop the running server instance",
						identifier : "stop"}
				]
			});
		} else {
			log.error("Instance build failed")

			const result = await octokit.checks.update({
				owner : github_ctx_base.owner,
				repo : github_ctx_base.repo,
				check_run_id : job_ctx.check_run_id,
				status: "completed",
				conclusion : "failure",
				output : {
					title : "Job Failure",
					summary : "`Log output`",
				}
			});
		}
	} catch(e) {
		log.error("Failed to update check_run: ", e);
	}
}

async function create_check_run(octokit, github_ctx, sha, name) {
	return await octokit.checks.create({
		owner : github_ctx.owner,
		repo : github_ctx.repo,
		name : name,
		head_sha : sha,
		status: "in_progress",
	});
}

export async function handle_check_suite(octokit, action, github_ctx_base, github_ctx_head, check_suite) {
	var log = logger.child({ checkSuite : check_suite.id})

	log.info("Check suite event. action='%s', branch='%s' url='%s'",
		action, github_ctx_base.branch, github_ctx_base.url);

	if (action !== "requested" && action !== "rerequested") {
		log.error("Unhandled check suite action='%s'", action);
		return;
	}

	await handle_check_run(octokit, action, github_ctx_base, github_ctx_head, check_suite, null)
}

async function build_instance(log, octokit, github_ctx, job_ctx) {
	const directory = app_config.build_directory + github_ctx.head_sha;
	const pack_file = "target/pslogin-1.0.2-SNAPSHOT.tar.gz"
	const run_path = "pslogin-1.0.2-SNAPSHOT/bin/ps-login"

	const job_output = [];
	const commands = [];

	log.info("Starting instance build...")

	// dont reclone if not needed
	if (!fs.existsSync(directory)) {
		commands.push(["git", ['clone', '--depth=50', '--branch='+github_ctx.branch, github_ctx.url, directory], "."]);
	}

	commands.push(["git", ["checkout", "-fq", github_ctx.head_sha], directory])
	commands.push(["sbt", ["-batch", "compile"], directory])
	commands.push(["sbt", ["-batch", "packArchive"], directory])
	commands.push(["tar" , ["xf", pack_file], directory])

	for (let i = 0; i < commands.length; i++) {
		const bin = commands[i][0];
		const args = commands[i][1];
		const dir = commands[i][2];
		const cmdline = bin + " " + args.join(" ");

		job_output.push("$ " + cmdline)
		
		// TODO: check if job has been cancelled early
		log.info("Running: " + cmdline)
		let output = await build.run_repo_command(dir, bin, args);

		if (output === null) {
			job_output.push("Command failed")
			return { job_output: job_output, job_result : false }
		} else {
			job_output.push(output)
		}
	}

	const job_args = ['forever'];
	job_output.push(run_path + " " + job_args.join(" "))

	// TODO: check if job has been cancelled early
	// TODO: control job output directory/file
	// this is asynchronous (returns immediately)
	const instance_info = build.run_repo_command_background(directory, run_path, job_args)

	let instance_id = -1;

	try {
		instance_id = await db.create_instance(job_ctx.job_id, directory, instance_info.pid, "out.log");
	} catch(e) {
		job_output.push("Failed to create instance row in DB")
		log.error("Failed to create instance row in DB ", e);
		return { job_output: job_output, job_result : false }
	}

	instance_info.on('close',  async (code) => {
		await db.delete_instance(instance_id);

		log.info("Process ended: %d", code)
	});

	return { job_output: job_output, job_result : true }
}

export async function handle_pull_request(octokit, action, pull_request, repo) {
	const pr = pull_request;
	const pr_head = pull_request.head;

	logger.info("Pull request '%s' (%s): %s",
		pr.title, pr.html_url,
		action);

	const github_ctx_base = {
		owner : repo.owner.login,
		repo : repo.name,
		branch : pr.base.ref,
		head_sha : pr.base.sha,
	};

	github_ctx_base.url = "https://github.com/" + github_ctx_base.owner + "/" + github_ctx_base.repo

	const github_ctx_head = {
		owner : pr_head.user.login,
		repo : pr_head.repo.name,
		branch : pr_head.ref,
		head_sha : pr_head.sha,
	};

	github_ctx_head.url = "https://github.com/" + github_ctx_head.owner + "/" + github_ctx_head.repo


	// pull request number as instance identifier

	if (action === "closed") {
		let resp;
		try {
			resp = await octokit.checks.listSuitesForRef({
				owner : github_ctx_base.owner,
				repo : github_ctx_base.repo,
				ref : github_ctx_head.head_sha,
			});
		} catch (e) {
			log.error("Unable to fetch existing check suites for PR: ", e)
			return;
		}

		const check_suites = resp.data.check_suites;
		let found_count = 0;

		for (let i = 0; i < check_suites.length; i++) {
			const cs = check_suites[i];
			const jobs = await db.get_jobs_by_suite(cs.id);

			for (let j = 0; j < jobs.length; j++) {
				found_count += 1
				await instance.stop_all_job(jobs[i].id);
			}
		}

		if (found_count === 0) {
			logger.warn("No check suites found for PR");
		}
	} else if (action === "reopened") {
		let resp;
		try {
			resp = await octokit.checks.listSuitesForRef({
				owner : github_ctx_base.owner,
				repo : github_ctx_base.repo,
				ref : github_ctx_head.head_sha,
			});
		} catch (e) {
			log.error("Unable to fetch existing check suites for PR: ", e)
			return;
		}

		const check_suites = resp.data.check_suites;
		let found_count = 0;

		for (let i = 0; i < check_suites.length; i++) {
			const cs = check_suites[i];
			const jobs = await db.get_jobs_by_suite(cs.id);
			if (jobs.length > 0) {
				found_count += 1
				await handle_check_suite(octokit, "rerequested", github_ctx_base, github_ctx_head, cs);
			}
		}

		if (found_count === 0) {
			logger.warn("No check suites found for PR");
		}
	} else if (action === "opened" || action === "synchronize") {
		let check_suite;
		try {
			check_suite = await octokit.checks.createSuite({
				owner : github_ctx_base.owner,
				repo : github_ctx_base.repo,
				head_sha : github_ctx_head.head_sha,
			});
		} catch (e) {
			logger.error("Failed to create check_suite for pull request:", e)
			return
		}

		check_suite = check_suite.data;

		await handle_check_suite(octokit, "requested", github_ctx_base, github_ctx_head, check_suite);
	} else {
		logger.error("Unhandled pull_request action='%s'", action);
		return;
	}
}
