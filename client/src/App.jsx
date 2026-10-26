import { PwaGate } from "./taxi/PwaGate";
import { DialogProvider } from "./taxi/AppDialog";
import { Notification } from "./taxi/Notification";
import Authentication from "./taxi/Authentication";
import TaxiApp from "./taxi/TaxiApp";
import useInit from "./hooks/useInit";
import useAppHeight from "./hooks/useAppHeight";

// App shell: PWA install gate -> dialogs -> login or the taxi workspace.
// The legacy Telegram-clone screens (contact chats, profile panel) are gone.
function App() {
  // Initialize application
  const { loggedIn } = useInit();
  useAppHeight();

  return (
    <PwaGate>
      <DialogProvider>
        <div className="w-full h-full flex overflow-hidden bg-primary relative">
          {loggedIn ? <TaxiApp /> : <Authentication />}

          {/* Notification */}
          <Notification />
        </div>
      </DialogProvider>
    </PwaGate>
  );
}

export default App;
