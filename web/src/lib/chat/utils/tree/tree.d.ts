// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
export type TreeId = string;

export type Tree<T> = {
	rootMessageId?: TreeId;
	messages: TreeNode<T>[];
};

export type TreeNode<T> = T & {
	id: TreeId;
	ancestors?: TreeId[];
	children?: TreeId[];
};

export type NewNode<T> = Omit<TreeNode<T>, "id">;
