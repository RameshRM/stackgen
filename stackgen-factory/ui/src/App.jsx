import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Shell from './components/Shell';
import Blueprint from './pages/Blueprint';
import BlueprintEditor from './pages/BlueprintEditor';
import Blueprints from './pages/Blueprints';
import Approvals from './pages/Approvals';
import Audit from './pages/Audit';
import Deployment from './pages/Deployment';
import Deployments from './pages/Deployments';
import Runs from './pages/Runs';
import Submit from './pages/Submit';
import { api } from './api';
import { signedIn } from './auth';
import SignIn from './pages/SignIn';
import { colour } from './theme';

function NotBuiltYet({ what }) {
    return (
        <div style={{ color: colour.muted, fontSize: 13 }}>
            {what} is not built yet.
        </div>
    );
}

export default function App() {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(signedIn());

    useEffect(() => {
        if (!token) { return; }
        // a token that is present but no longer good puts us back at sign-in
        // rather than at a screen full of failures nobody can act on
        api.me().then(setUser).catch(() => { setToken(false); });
    }, [token]);

    if (!token) {
        return <SignIn onSignedIn={() => setToken(true)} />;
    }
    if (!user) {
        return <div style={{ color: colour.muted, margin: 32 }}>Loading…</div>;
    }

    return (
        <Shell user={user}>
            <Routes>
                <Route path="/" element={<Navigate to="/blueprints" replace />} />
                <Route path="/blueprints" element={<Blueprints />} />
                <Route path="/blueprints/new" element={<BlueprintEditor />} />
                <Route path="/blueprints/:name/edit" element={<BlueprintEditor />} />
                <Route path="/blueprints/:name" element={<Blueprint />} />
                <Route path="/runs" element={<Runs />} />
                <Route path="/approvals" element={<Approvals />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="/submit/:name" element={<Submit />} />
                <Route path="/deployments" element={<Deployments />} />
                <Route path="/deployments/:id" element={<Deployment />} />
                <Route path="*" element={<NotBuiltYet what="That page" />} />
            </Routes>
        </Shell>
    );
}
