/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest';
import { WebClient } from '@slack/web-api';
import { GitHubIssue } from '../api/api';
import { safeLog } from '../common/utils';

interface PR {
	number: number;
	body: string;
	additions: number;
	deletions: number;
	changed_files: number;
	url: string;
	owner: string;
	draft: boolean;
	/**
	 * The branch you're merging into i.e main
	 */
	baseBranchName: string;
	/**
	 * The branch the PR is created from i.e. feature/foo
	 */
	headBranchName: string;
	title: string;
}

// Some slack typings since the API isn't the best in terms of typings
interface SlackReaction {
	name: string;
	count: number;
	users: string[];
}

interface SlackMessage {
	type: 'message';
	// Tombstone if deleted, channel_join if it's a join message.
	subtype: 'tombstone' | 'channel_join' | undefined;
	text: string;
	reply_count?: number;
	ts: string;
	reactions?: SlackReaction[];
}

export interface Options {
	slackToken: string;
	codereviewChannel: string;
	payload: {
		owner: string;
		repo: string;
		repo_full_name: string;
		repo_url: string | undefined;
		pr: PR;
	};
}

class Chatter {
	constructor(protected slackToken: string, protected notificationChannel: string) {}

	async getChat(): Promise<{ client: WebClient; channel: string }> {
		const web = new WebClient(this.slackToken);
		const memberships = await listAllMemberships(web);

		const codereviewChannel =
			this.notificationChannel && memberships.find((m) => m.name === this.notificationChannel);

		if (!codereviewChannel) {
			throw Error(`Slack channel not found: ${this.notificationChannel}`);
		}
		return { client: web, channel: codereviewChannel.id };
	}
}

export class CodeReviewChatDeleter extends Chatter {
	private elevatedClient: WebClient | undefined;
	constructor(
		slackToken: string,
		slackElevatedUserToken: string | undefined,
		notificationChannel: string,
		private prUrl: string,
	) {
		super(slackToken, notificationChannel);
		this.elevatedClient = slackElevatedUserToken ? new WebClient(slackElevatedUserToken) : undefined;
	}

	async run() {
		const { client, channel } = await this.getChat();
		// Get the last 20 messages (don't bother looking further than that)
		const response = await client.conversations.history({
			channel,
			limit: 20,
		});
		if (!response.ok || !response.messages) {
			throw Error('Error getting channel history');
		}
		const messages = response.messages as SlackMessage[];

		const messagesToDelete = messages.filter((message) => {
			const isCodeReviewMessage = message.text.includes(this.prUrl);
			// If it has a subtype it means its a special slack message which we want to delete
			if (message.subtype) {
				return true;
			}
			if (this.elevatedClient && message.reactions) {
				// If we have an elevated client we can delete the message as long it has a "white_check_mark" reaction
				return (
					isCodeReviewMessage ||
					message.reactions.some((reaction) => reaction.name === 'white_check_mark')
				);
			}
			return isCodeReviewMessage;
		});

		// Delete all the replies to messages queued for deletion
		const replies: SlackMessage[] = [];
		for (const message of messagesToDelete) {
			// If reply count is greater than 1 we must fetch the replies
			if (message.reply_count) {
				const replyThread = await client.conversations.replies({
					channel,
					ts: message.ts,
				});
				if (!replyThread.ok || !replyThread.messages) {
					safeLog('Error getting messages replies');
				} else {
					// Pushback everything but the first reply since the first reply is the original message
					replies.push(...(replyThread.messages as SlackMessage[]).slice(1));
				}
			}
		}
		messagesToDelete.push(...replies);

		if (messagesToDelete.length === 0) {
			safeLog('no message found, exiting');
			return;
		}
		try {
			// Attempt to use the correct client to delete the messages
			for (const message of messagesToDelete) {
				// Can't delete already deleted messages.
				// The reason they're in the array is so we can get their replies
				if (message.subtype === 'tombstone') {
					continue;
				}
				if (this.elevatedClient) {
					await this.elevatedClient.chat.delete({
						channel,
						ts: message.ts,
						as_user: true,
					});
				} else {
					await client.chat.delete({
						channel,
						ts: message.ts,
						as_user: false,
					});
				}
			}
		} catch (e) {
			safeLog('error deleting message, probably posted by some human');
		}
	}
}

export class CodeReviewChat extends Chatter {
	private pr: PR;
	constructor(private octokit: Octokit, private issue: GitHubIssue, private options: Options) {
		super(options.slackToken, options.codereviewChannel);
		this.pr = options.payload.pr;
	}

	private async postMessage(message: string) {
		const { client, channel } = await this.getChat();

		await client.chat.postMessage({
			text: message,
			channel,
			link_names: true,
		});
	}

	async run() {
		if (this.pr.draft) {
			safeLog('PR is draft, ignoring');
			return;
		}

		// TODO @lramos15 possibly make this configurable
		if (this.pr.baseBranchName.startsWith('release')) {
			safeLog('PR is on a release branch, ignoring');
			return;
		}

		const data = await this.issue.getIssue();
		const author = data.author;
		// Author must have write access to the repo or be a bot
		if (
			(!(await this.issue.hasWriteAccess(author)) && !author.isGitHubApp) ||
			author.name.includes('dependabot')
		) {
			safeLog('Issue author not team member, ignoring');
			return;
		}
		const tasks = [];

		if (!data.assignee && !author.isGitHubApp) {
			tasks.push(this.issue.addAssignee(author.name));
		}

		tasks.push(
			(async () => {
				const currentMilestone = await this.issue.getCurrentRepoMilestone();
				if (!data.milestone && currentMilestone) {
					await this.issue.setMilestone(currentMilestone);
				}
			})(),
		);

		tasks.push(
			(async () => {
				const [existingReviews, existingRequests] = await Promise.all([
					this.octokit.pulls.listReviews({
						owner: this.options.payload.owner,
						repo: this.options.payload.repo,
						pull_number: this.options.payload.pr.number,
					}),
					this.octokit.pulls.listRequestedReviewers({
						owner: this.options.payload.owner,
						repo: this.options.payload.repo,
						pull_number: this.options.payload.pr.number,
					}),
				]);

				// Check if there is any exisitng review. This excludes the author themselves as they don't count
				const hasExistingReview = existingReviews?.data?.some((review) => {
					return review.user?.login !== author.name;
				});

				// Check to see if there is an existing review or review request. We don't check if the author is part of the review request as that isn't possible
				const hasExisting = hasExistingReview || existingRequests?.data?.users?.length;
				if (hasExisting) {
					safeLog('had existing review requests, exiting');
					return;
				}

				const cleanTitle = this.pr.title.replace(/`/g, '');
				const changedFilesMessage =
					`${this.pr.changed_files} file` + (this.pr.changed_files > 1 ? 's' : '');
				const diffMessage = `+${this.pr.additions.toLocaleString()} -${this.pr.deletions.toLocaleString()}, ${changedFilesMessage}`;
				// The message that states which repo the PR is in, only populated for non microsoft/vscode PRs
				const repoMessage =
					this.options.payload.repo_full_name === 'microsoft/vscode'
						? ':'
						: ` (in ${this.options.payload.repo_full_name}):`;

				const githubUrl = this.pr.url;
				const vscodeDevUrl = this.pr.url.replace('https://', 'https://insiders.vscode.dev/');

				// Nicely formatted chat message
				const message = `*${cleanTitle}* by _${this.pr.owner}_${repoMessage} \`${diffMessage}\` <${githubUrl}|Review (GH)> | <${vscodeDevUrl}|Review (VSCode)>`;
				safeLog(message);
				await this.postMessage(message);
			})(),
		);

		await Promise.all(tasks);
	}
}

interface Channel {
	id: string;
	name: string;
	is_member: boolean;
}

interface ConversationsList {
	channels: Channel[];
	response_metadata?: {
		next_cursor?: string;
	};
}

async function listAllMemberships(web: WebClient) {
	let groups: ConversationsList | undefined;
	const channels: Channel[] = [];
	do {
		try {
			groups = (await web.conversations.list({
				types: 'public_channel,private_channel',
				cursor: groups?.response_metadata?.next_cursor,
				limit: 100,
			})) as unknown as ConversationsList;
			channels.push(...groups.channels);
		} catch (err) {
			safeLog(`Error listing channels: ${err}`);
			groups = undefined;
		}
	} while (groups?.response_metadata?.next_cursor);
	return channels.filter((c) => c.is_member);
}
