import ChatBubble from '~icons/material-symbols/chat-bubble-outline';
import Alert16Regular from '~icons/fluent/alert-16-regular';
import ArrowReply16Regular from '~icons/fluent/arrow-reply-16-regular';
import Link16Regular from '~icons/fluent/link-16-regular';
import Checkmark16Regular from '~icons/fluent/checkmark-16-regular';
import ChevronLeft from '~icons/fluent/chevron-left-16-filled';
import ChevronRight from '~icons/fluent/chevron-right-16-filled';
import Clock16Regular from '~icons/fluent/clock-16-regular';
import Comment16Regular from '~icons/fluent/comment-16-regular';
import Dismiss16Regular from '~icons/fluent/dismiss-16-regular';
import Info16Regular from '~icons/fluent/info-16-regular';
import Open16Regular from '~icons/fluent/open-16-regular';
import Send16Regular from '~icons/fluent/send-16-regular';
import Settings16Regular from '~icons/fluent/settings-16-regular';
import ShieldTask16Regular from '~icons/fluent/shield-task-16-regular';
import ThumbLikeDislike16Regular from '~icons/fluent/thumb-like-dislike-16-regular';

export const icons = {
	'alert-16-regular': Alert16Regular,
	'arrow-reply-16-regular': ArrowReply16Regular,
	'link-16-regular': Link16Regular,
	'chat-bubble': ChatBubble,
	'checkmark-16-regular': Checkmark16Regular,
	'chevron-left': ChevronLeft,
	'chevron-right': ChevronRight,
	'clock-16-regular': Clock16Regular,
	'comment-16-regular': Comment16Regular,
	'dismiss-16-regular': Dismiss16Regular,
	'info-16-regular': Info16Regular,
	'open-16-regular': Open16Regular,
	'send-16-regular': Send16Regular,
	'settings-16-regular': Settings16Regular,
	'shield-task-16-regular': ShieldTask16Regular,
	'thumb-like-dislike-16-regular': ThumbLikeDislike16Regular
} as const;

export type IconName = keyof typeof icons;
