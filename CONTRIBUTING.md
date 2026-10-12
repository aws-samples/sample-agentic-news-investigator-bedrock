# Contributing Guidelines

Thank you for your interest in contributing to this sample. Whether it's a bug report,
new feature, correction, or additional documentation, we greatly value feedback and
contributions from our community.

Please read through this document before submitting any issues or pull requests to
ensure we have all the necessary information to effectively respond to your bug report
or contribution.

## Reporting bugs and feature requests

Use the issue tracker to report bugs or suggest features. Before filing, check existing
open and recently closed issues to make sure somebody else hasn't already reported it.
Please include as much information as you can, for example:

* A reproducible test case or series of steps
* The version of the code being used (commit)
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment

## Contributing via pull requests

Contributions via pull requests are much appreciated. Before sending one, please ensure
that:

1. You are working against the latest source on the `main` branch.
2. You check existing open and recently merged pull requests to make sure someone else
   hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be
   wasted.

To send us a pull request:

1. Fork the repository.
2. Modify the source; focus on the specific change you are contributing. If you also
   reformat all the code, it will be hard for us to focus on your change.
3. Run the same checks CI runs (`.gitlab-ci.yml`): `cargo test --workspace`, and in `v2/`
   `npm run build && npm test`, in `infra/` `npm test && npx cdk synth -c contactEmail=you@example.com`.
   CI also runs ASH, Ferret, detect-secrets and the publication scrub; any finding fails
   the pipeline.
4. Commit to your fork using clear commit messages.
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay
   involved in the conversation.

Two project rules worth knowing before you start:

* **Test through the replay bench, never the live bus.** Do not publish synthetic or test
  events onto the event bus or a worker queue: a worker that consumes one will trade on
  it. `npm run replay` in `v2/` replays archived events against a simulated book.
* **Material changes to the security posture** (new tools for the agent, new outbound
  network access, IAM changes) need an update to `docs/threat-model.tc.json`, re-rendered
  with `node scripts/render-threat-model.mjs`.

## Finding contributions to work on

Looking at the existing issues is a great way to find something to contribute on.

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.

## Security issue notifications

If you discover a potential security issue in this project we ask that you notify AWS/Amazon
Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/).
Please do **not** create a public issue. See [SECURITY.md](SECURITY.md).

## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the
licensing of your contribution.
