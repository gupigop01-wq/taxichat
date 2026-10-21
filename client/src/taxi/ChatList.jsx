import { useEffect, useState } from "react";
import { apiGet } from "./api";
import DirectChat from "./DirectChat";
import { IconText } from "./TaxiIcon";

// List of dialogs from direct calls with the peer name, car caption, unread
// badge and the last message preview (concept 1.6)
const ChatList = ({ onOpen, refreshKey = 0 }) => {
  const [chats, setChats] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiGet("/api/chats/my")
      .then((res) => setChats(res.data.chats))
      .catch((err) => setError(err.message));
  }, [refreshKey]);

  if (error) return <div className="text-danger text-sm">{error}</div>;

  if (chats.length === 0) {
    return (
      <div className="text-secondary-text text-sm">
        Диалогов пока нет. Позвоните свободному водителю — диалог появится здесь.
      </div>
    );
  }

  return (
    <div className="space-y-2 max-w-[42rem] mx-auto w-full">
      {chats.map((chat) => (
        <button
          key={chat._id}
          className="press glass anim-rise w-full text-center rounded-2xl p-3 text-sm"
          onClick={() => onOpen(chat._id)}
        >
          <div className="flex items-center gap-2">
            <div className="font-semibold text-center">{chat.peer?.name}</div>
            {chat.unreadCount > 0 && (
              <span className="ml-auto bg-danger text-white rounded-full px-2 text-xs">
                {chat.unreadCount}
              </span>
            )}
          </div>
          {chat.carCaption && <div className="text-secondary-text text-center">{chat.carCaption}</div>}
          {chat.lastMessage && (
            <div className="text-secondary-text truncate">
               <IconText>{chat.lastMessage.kind === "photo"
                 ? "📷 Фото"
                 : chat.lastMessage.kind === "voice"
                   ? "🎤 Голосовое"
                   : chat.lastMessage.body}</IconText>
            </div>
          )}
        </button>
      ))}
    </div>
  );
};

export default ChatList;

