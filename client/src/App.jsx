import DeleteChat from "./components/globals/DeleteChat";
import DeleteContact from "./components/globals/DeleteContact";
import NewContactForm from "./components/globals/NewContactForm";
import VoiceCallModal from "./components/globals/VoiceCallModal";
import Authentication from "./pages/Authentication";
import UserProfile from "./pages/UserProfile";
import TaxiApp from "./taxi/TaxiApp";
import useInit from "./hooks/useInit";
import Notification from "./components/globals/Notification";
import { DialogProvider } from "./taxi/AppDialog";
import { PwaGate } from "./taxi/PwaGate";
import { useSelector } from "react-redux";
import useAppHeight from "./hooks/useAppHeight";

function App() {
  // Initialize application
  const { loggedIn } = useInit();
  const modalType = useSelector((state) => state.modalReducer.type);
  useAppHeight();

  return (
    <PwaGate>
    <DialogProvider>
    <div className="w-full h-full flex overflow-hidden bg-primary relative">
      {loggedIn && (
        <>
          {/* TaxiChat workspace (legacy contact chats inside the "Чаты" tab) */}
          <TaxiApp />
          <UserProfile />
        </>
      )}

      {!loggedIn && <Authentication />}

      {/* Notification */}
      <Notification />

      {/* Modals */}
      <DeleteChat />
      <DeleteContact />
      <NewContactForm />

      {modalType === "voiceCallModal" && <VoiceCallModal />}
    </div>
    </DialogProvider>
    </PwaGate>
  );
}

export default App;
